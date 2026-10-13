import { trace } from "@opentelemetry/api";
import { anthropicExtensionOf, withNativeEvent } from "../../core/anthropic.js";
import type { ChatChunk, ChatRequest } from "../../core/chat.js";
import {
  embeddingsNotSupported,
  GatewayError,
  upstreamError,
  upstreamTimeout,
} from "../../core/errors.js";
import {
  type CallContext,
  type ChatProvider,
  type ChatResult,
  type ChatStream,
  type HttpClient,
  type HttpHeaders,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "../../core/provider.js";
import { nativeRequestBody } from "../anthropic/native.js";
import { toAnthropicRequest } from "../anthropic/outbound-request.js";
import { toChatCompletion } from "../anthropic/outbound-response.js";
import { createStreamTranslator } from "../anthropic/outbound-stream.js";
import { errorFromStatus, markRetryable } from "../anthropic/upstream-errors.js";
import { abortedCallError } from "./abort.js";
import { decodeSse } from "./sse.js";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export interface AnthropicProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultMaxTokens: number;
}

export interface AnthropicProviderOptions {
  /** Seconds since the epoch, for `created` in translated responses. */
  now?: () => number;
}

/**
 * The `anthropic` adapter (spec 014): canonical requests in, canonical responses out, through
 * `POST {baseUrl}/v1/messages`. Requests carrying the Anthropic extension (same-family
 * `/v1/messages`, ADR-0016) are re-emitted natively and also return the raw upstream data.
 */
export function createAnthropicProvider(
  config: AnthropicProviderConfig,
  http: HttpClient,
  options: AnthropicProviderOptions = {},
): ChatProvider {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const name = config.name;

  /** Upstream body and headers; also records dropped parameters on the upstream span. */
  function prepare(request: ChatRequest, stream: boolean) {
    const headers: Record<string, string> = {
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
    const extension = anthropicExtensionOf(request);
    let body: Record<string, unknown>;
    if (extension) {
      body = nativeRequestBody(extension, request);
      if (extension.beta) headers["anthropic-beta"] = extension.beta;
    } else {
      const translated = toAnthropicRequest(request, config);
      body = translated.body;
      if (translated.dropped.length > 0) {
        trace
          .getActiveSpan()
          ?.setAttribute("switchyard.dropped_params", translated.dropped.join(","));
      }
    }
    if (stream) body.stream = true;
    return { body, headers, native: extension !== undefined };
  }

  /** Transport failures → retryable gateway errors; caller aborts → 502/504 (client gone). */
  function transportError(error: unknown, signal: AbortSignal): unknown {
    if (error instanceof GatewayError) return error;
    if (signal.aborted) return abortedCallError(name, signal);
    if (error instanceof UpstreamTimeoutError) return markRetryable(upstreamTimeout(name), true);
    if (error instanceof UpstreamNetworkError) return markRetryable(upstreamError(name), true);
    return error;
  }

  function recordRequestId(headers: HttpHeaders | undefined): void {
    const id = headers?.["request-id"];
    if (id) trace.getActiveSpan()?.setAttribute("switchyard.upstream.request_id", id);
  }

  return {
    name,
    type: "anthropic",

    async chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult> {
      const { body, headers, native } = prepare(request, false);
      let response: Awaited<ReturnType<HttpClient["postJson"]>>;
      try {
        response = await http.postJson(url, body, { headers, signal: ctx.signal });
      } catch (error) {
        throw transportError(error, ctx.signal);
      }
      recordRequestId(response.headers);
      if (response.status < 200 || response.status >= 300) {
        throw errorFromStatus(name, response.status, response.text, response.headers);
      }
      let parsed: unknown;
      let translated: ReturnType<typeof toChatCompletion>;
      try {
        parsed = JSON.parse(response.text);
        translated = toChatCompletion(parsed, now());
      } catch {
        throw markRetryable(upstreamError(name), true);
      }
      return {
        body: translated.body,
        usage: translated.usage,
        responseModel: translated.responseModel,
        ...(native && { native: parsed }),
      };
    },

    async chatStream(request: ChatRequest, ctx: CallContext): Promise<ChatStream> {
      const { body, headers, native } = prepare(request, true);
      let response: Awaited<ReturnType<HttpClient["postStream"]>>;
      try {
        response = await http.postStream(url, body, { headers, signal: ctx.signal });
      } catch (error) {
        throw transportError(error, ctx.signal);
      }
      recordRequestId(response.headers);
      if (response.status < 200 || response.status >= 300) {
        const text = await response.text().catch(() => "");
        throw errorFromStatus(name, response.status, text, response.headers);
      }

      const translator = createStreamTranslator(name, now());
      return (async function* (): AsyncGenerator<ChatChunk> {
        try {
          for await (const data of decodeSse(response.body)) {
            const event = parseEvent(data);
            if (!event) throw upstreamError(name);
            const chunks = translator.next(event);
            if (native) {
              // One chunk per upstream event so /v1/messages can forward it unchanged.
              const [first, ...rest] = chunks;
              const carrier = first ?? { object: "chat.completion.chunk", choices: [] };
              yield withNativeEvent(carrier, { type: event.type, data });
              yield* rest;
            } else {
              yield* chunks;
            }
            if (translator.done) return;
          }
        } catch (error) {
          throw transportError(error, ctx.signal);
        }
        // The connection closed without `message_stop`: the answer may be incomplete.
        throw markRetryable(upstreamError(name), true);
      })();
    },

    async embeddings() {
      throw embeddingsNotSupported(name);
    },
  };
}

function parseEvent(data: string): (Record<string, unknown> & { type: string }) | undefined {
  try {
    const event: unknown = JSON.parse(data);
    if (typeof event === "object" && event !== null && "type" in event) {
      const record = event as Record<string, unknown>;
      if (typeof record.type === "string")
        return record as Record<string, unknown> & { type: string };
    }
  } catch {
    // fall through
  }
  return undefined;
}
