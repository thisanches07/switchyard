import { Readable } from "node:stream";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { Principal } from "../../core/auth.js";
import type { ChatChunk, ChatRequest, Usage } from "../../core/chat.js";
import { GatewayError, upstreamError } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import type { Admission } from "../ratelimit/admission.js";
import type { OutcomeTracker } from "../usage/outcome.js";
import { startUpstreamSpan } from "./telemetry.js";
import { deltaText, estimateTokens, forwardChunk, messageChars, usageFromChunk } from "./usage.js";

export interface StreamChatArgs {
  reply: FastifyReply;
  provider: ChatProvider;
  /** Request already rewritten with the resolved model. */
  request: ChatRequest;
  logger: FastifyBaseLogger;
  principal?: Principal | undefined;
  admission?: Admission | undefined;
  /** Outcome tracker of the admitted request (spec 006). */
  outcome?: OutcomeTracker | undefined;
  /** Wire format of the stream; defaults to OpenAI `chat.completion.chunk` SSE. */
  encoder?: StreamEncoder | undefined;
}

/** Turns canonical chunks into the SSE format of the route the client called (spec 014). */
export interface StreamEncoder {
  chunk(chunk: ChatChunk): string[];
  /** After the last chunk; `usage` is reported or estimated. */
  end(usage: Usage): string[];
  /** The single error event that ends a stream after the first byte (ADR-0008). */
  error(error: GatewayError): string;
}

const sseEvent = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** OpenAI SSE: chunks as `data:` events (usage rules of spec 003 AC-7), then `[DONE]`. */
export function openAiEncoder(clientWantsUsage: boolean): StreamEncoder {
  return {
    chunk(chunk) {
      const forwarded = forwardChunk(chunk, clientWantsUsage);
      return forwarded ? [sseEvent(forwarded)] : [];
    },
    end: () => ["data: [DONE]\n\n"],
    error: (error) => sseEvent(error.toBody()),
  };
}

/**
 * Proxies a streaming chat completion (spec 003).
 *
 * Failures before the first chunk throw (JSON error via the app error handler). Once the first
 * chunk is in hand, headers are sent and the rest is piped with backpressure; a failure from then
 * on becomes an SSE error event and is never retried (ADR-0008).
 */
export async function streamChat({
  reply,
  provider,
  request,
  logger,
  principal,
  admission,
  outcome,
  encoder: customEncoder,
}: StreamChatArgs) {
  const controller = new AbortController();
  let clientClosed = false;
  reply.raw.once("close", () => {
    if (reply.raw.writableFinished) return;
    clientClosed = true;
    controller.abort();
  });

  const upstream = startUpstreamSpan({
    provider,
    model: request.model,
    logger,
    stream: true,
    principal,
  });

  let iterator: AsyncIterator<ChatChunk>;
  let first: IteratorResult<ChatChunk>;
  try {
    const stream = await upstream.run(() =>
      provider.chatStream(request, { signal: controller.signal }),
    );
    iterator = stream[Symbol.asyncIterator]();
    first = await upstream.run(() => iterator.next());
  } catch (error) {
    if (clientClosed) upstream.clientGone();
    else upstream.fail(error, "before_first_byte");
    // Nothing was generated: the whole token reservation goes back (spec 005, AC-6).
    await admission?.reconcile(undefined);
    if (clientClosed) outcome?.clientClosed({ headersSent: false });
    else outcome?.fail(error);
    throw error;
  }

  const ttfbMs = upstream.firstChunk();
  const responseModel = first.done ? undefined : modelOf(first.value);
  const encoder = customEncoder ?? openAiEncoder(includeUsage(request));

  reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("x-accel-buffering", "no")
    .header("x-switchyard-ttfb-ms", Math.round(ttfbMs));

  async function* events(): AsyncGenerator<string> {
    let usage: Usage | undefined;
    let outputChars = 0;
    let settled = false;
    const inputTokens = estimateTokens(messageChars(request));
    /** Usage so far: provider-reported if seen, else the spec 003 estimate of what was streamed. */
    const sofar = () => ({
      usage: usage ?? { inputTokens, outputTokens: estimateTokens(outputChars) },
      estimated: usage === undefined,
      ttfbMs,
    });
    /** Tokens generated so far, for reconciling streams that did not finish. */
    const partialTokens = () => {
      const { usage: u } = sofar();
      return u.inputTokens + u.outputTokens;
    };
    try {
      let result = first;
      while (!result.done) {
        const chunk = result.value;
        usage = usageFromChunk(chunk) ?? usage;
        outputChars += deltaText(chunk).length;
        yield* encoder.chunk(chunk);
        result = await iterator.next();
      }
      settled = true;
      const final = sofar();
      upstream.succeed({ usage: final.usage, estimated: final.estimated, responseModel });
      await admission?.reconcile(final.usage.inputTokens + final.usage.outputTokens);
      outcome?.succeed(final);
      yield* encoder.end(final.usage);
    } catch (error) {
      settled = true;
      await admission?.reconcile(partialTokens());
      if (clientClosed) {
        upstream.clientGone();
        outcome?.clientClosed({ headersSent: true, ...sofar() });
        return;
      }
      upstream.fail(error, "midstream");
      const gatewayError = error instanceof GatewayError ? error : upstreamError(provider.name);
      // Headers (200) are gone: the SSE error event is the error the client sees (ADR-0008).
      outcome?.failMidstream(gatewayError, sofar());
      yield encoder.error(gatewayError);
    } finally {
      if (!settled) {
        // The response stream was destroyed (client went away) while we were between chunks.
        controller.abort();
        upstream.clientGone();
        await admission?.reconcile(partialTokens());
        outcome?.clientClosed({ headersSent: true, ...sofar() });
        await iterator.return?.();
      }
    }
  }

  return reply.send(Readable.from(events()));
}

function includeUsage(request: ChatRequest): boolean {
  const options = request.stream_options;
  return (
    typeof options === "object" &&
    options !== null &&
    (options as { include_usage?: unknown }).include_usage === true
  );
}

function modelOf(chunk: ChatChunk): string | undefined {
  return typeof chunk.model === "string" ? chunk.model : undefined;
}
