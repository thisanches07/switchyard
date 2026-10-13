import { Readable } from "node:stream";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { Principal } from "../../core/auth.js";
import type { ChatChunk, ChatRequest, Usage } from "../../core/chat.js";
import { GatewayError, upstreamError } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import type { Admission } from "../ratelimit/admission.js";
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
}

const sseEvent = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * Proxies a streaming chat completion (spec 003).
 *
 * Failures before the first chunk throw (JSON error via the app error handler). Once the first
 * chunk is in hand, headers are sent and the rest is piped with backpressure; a failure from then
 * on becomes an SSE error event and is never retried (ADR-0008).
 */
export async function streamChat({ reply, provider, request, logger, principal }: StreamChatArgs) {
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
    throw error;
  }

  const ttfbMs = upstream.firstChunk();
  const responseModel = first.done ? undefined : modelOf(first.value);
  const clientWantsUsage = includeUsage(request);

  reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("x-accel-buffering", "no")
    .header("x-switchyard-ttfb-ms", Math.round(ttfbMs));

  async function* events(): AsyncGenerator<string> {
    let usage: Usage | undefined;
    let outputChars = 0;
    let settled = false;
    try {
      let result = first;
      while (!result.done) {
        const chunk = result.value;
        usage = usageFromChunk(chunk) ?? usage;
        outputChars += deltaText(chunk).length;
        const forwarded = forwardChunk(chunk, clientWantsUsage);
        if (forwarded) yield sseEvent(forwarded);
        result = await iterator.next();
      }
      settled = true;
      upstream.succeed({
        usage: usage ?? {
          inputTokens: estimateTokens(messageChars(request)),
          outputTokens: estimateTokens(outputChars),
        },
        estimated: usage === undefined,
        responseModel,
      });
      yield "data: [DONE]\n\n";
    } catch (error) {
      settled = true;
      if (clientClosed) {
        upstream.clientGone();
        return;
      }
      upstream.fail(error, "midstream");
      const gatewayError = error instanceof GatewayError ? error : upstreamError(provider.name);
      yield sseEvent(gatewayError.toBody());
    } finally {
      if (!settled) {
        // The response stream was destroyed (client went away) while we were between chunks.
        controller.abort();
        upstream.clientGone();
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
