import { z } from "zod";
import type { ChatRequest } from "../../core/chat.js";
import {
  providerNotImplemented,
  upstreamClientError,
  upstreamError,
  upstreamTimeout,
} from "../../core/errors.js";
import {
  type CallContext,
  type ChatProvider,
  type ChatResult,
  type HttpClient,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "../../core/provider.js";
import { abortedCallError } from "./abort.js";

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey?: string | undefined;
}

// Only the fields the gateway reads; the body itself is returned untouched.
const completionMeta = z.looseObject({
  model: z.string().optional(),
  usage: z
    .looseObject({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .optional()
    .catch(undefined),
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
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  return {
    name: config.name,
    type: "openai-compatible",
    async chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult> {
      let response: Awaited<ReturnType<HttpClient["postJson"]>>;
      try {
        response = await http.postJson(url, request, { headers, signal: ctx.signal });
      } catch (error) {
        if (error instanceof UpstreamTimeoutError) throw upstreamTimeout(config.name);
        if (error instanceof UpstreamNetworkError) throw upstreamError(config.name);
        if (ctx.signal.aborted) throw abortedCallError(config.name, ctx.signal);
        throw error;
      }

      const parsed = parseJson(response.text);

      if (response.status >= 200 && response.status < 300) {
        const meta = completionMeta.safeParse(parsed);
        if (parsed === undefined || !meta.success) throw upstreamError(config.name);
        const usage = meta.data.usage;
        return {
          body: parsed,
          usage: usage && {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          },
          responseModel: meta.data.model,
        };
      }

      if (response.status >= 400 && response.status < 500) {
        const fields = upstreamErrorBody.safeParse(parsed);
        throw upstreamClientError(response.status, fields.success ? fields.data.error : {});
      }

      // 5xx and anything unexpected: do not forward the upstream body (may leak internals).
      throw upstreamError(config.name);
    },
    async chatStream() {
      throw providerNotImplemented(config.name, "streaming");
    },
    async embeddings() {
      throw providerNotImplemented(config.name, "embeddings");
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
