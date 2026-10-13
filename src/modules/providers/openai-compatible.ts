import { z } from "zod";
import type { ChatChunk, ChatRequest, EmbeddingsRequest } from "../../core/chat.js";
import {
  GatewayError,
  upstreamClientError,
  upstreamError,
  upstreamTimeout,
} from "../../core/errors.js";
import {
  type CallContext,
  type ChatProvider,
  type ChatResult,
  type ChatStream,
  type EmbeddingsResult,
  type HttpClient,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "../../core/provider.js";
import { abortedCallError } from "./abort.js";
import { decodeSse } from "./sse.js";

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey?: string | undefined;
}

// Only the fields the gateway reads; bodies themselves are returned untouched.
const completionMeta = z.looseObject({
  model: z.string().optional(),
  usage: z
    .looseObject({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      // Prompt-cache read tokens (spec 006); providers without prompt caching omit it.
      prompt_tokens_details: z
        .looseObject({ cached_tokens: z.number() })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const embeddingsMeta = z.looseObject({
  model: z.string().optional(),
  usage: z.looseObject({ prompt_tokens: z.number() }).optional().catch(undefined),
});

const upstreamErrorBody = z.looseObject({
  error: z.looseObject({
    message: z.string().optional().catch(undefined),
    type: z.string().optional().catch(undefined),
    code: z.string().optional().catch(undefined),
  }),
});

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
  http: HttpClient,
): ChatProvider {
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  /** Maps transport failures; GatewayErrors pass through; caller aborts become gateway errors. */
  function transportError(error: unknown, signal: AbortSignal): unknown {
    if (error instanceof GatewayError) return error;
    if (error instanceof UpstreamTimeoutError) return upstreamTimeout(config.name);
    if (error instanceof UpstreamNetworkError) return upstreamError(config.name);
    if (signal.aborted) return abortedCallError(config.name, signal);
    return error;
  }

  /** Non-2xx response → gateway error. 4xx are passed through; 5xx bodies are never forwarded. */
  function statusError(status: number, text: string): GatewayError {
    if (status >= 400 && status < 500) {
      const fields = upstreamErrorBody.safeParse(parseJson(text));
      return upstreamClientError(status, fields.success ? fields.data.error : {});
    }
    return upstreamError(config.name);
  }

  async function postJson(path: string, body: unknown, ctx: CallContext): Promise<unknown> {
    let response: Awaited<ReturnType<HttpClient["postJson"]>>;
    try {
      response = await http.postJson(`${base}${path}`, body, { headers, signal: ctx.signal });
    } catch (error) {
      throw transportError(error, ctx.signal);
    }
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, response.text);
    }
    const parsed = parseJson(response.text);
    if (parsed === undefined) throw upstreamError(config.name);
    return parsed;
  }

  return {
    name: config.name,
    type: "openai-compatible",

    async chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult> {
      const parsed = await postJson("/chat/completions", request, ctx);
      const meta = completionMeta.safeParse(parsed);
      if (!meta.success) throw upstreamError(config.name);
      const usage = meta.data.usage;
      const cached = usage?.prompt_tokens_details?.cached_tokens;
      return {
        body: parsed,
        usage: usage && {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        },
        responseModel: meta.data.model,
      };
    },

    async chatStream(request: ChatRequest, ctx: CallContext): Promise<ChatStream> {
      const clientOptions =
        typeof request.stream_options === "object" && request.stream_options !== null
          ? request.stream_options
          : {};
      // Always ask for usage; the proxy decides whether the client sees it (spec 003 AC-7).
      const body = {
        ...request,
        stream: true,
        stream_options: { ...clientOptions, include_usage: true },
      };

      let response: Awaited<ReturnType<HttpClient["postStream"]>>;
      try {
        response = await http.postStream(`${base}/chat/completions`, body, {
          headers,
          signal: ctx.signal,
        });
      } catch (error) {
        throw transportError(error, ctx.signal);
      }
      if (response.status < 200 || response.status >= 300) {
        const text = await response.text().catch(() => "");
        throw statusError(response.status, text);
      }

      const name = config.name;
      return (async function* (): AsyncGenerator<ChatChunk> {
        try {
          for await (const data of decodeSse(response.body)) {
            const chunk = parseJson(data);
            if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
              throw upstreamError(name);
            }
            yield chunk as ChatChunk;
          }
        } catch (error) {
          throw transportError(error, ctx.signal);
        }
      })();
    },

    async embeddings(request: EmbeddingsRequest, ctx: CallContext): Promise<EmbeddingsResult> {
      const parsed = await postJson("/embeddings", request, ctx);
      const meta = embeddingsMeta.safeParse(parsed);
      if (!meta.success) throw upstreamError(config.name);
      return {
        body: parsed,
        usage: meta.data.usage && { inputTokens: meta.data.usage.prompt_tokens },
        responseModel: meta.data.model,
      };
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
