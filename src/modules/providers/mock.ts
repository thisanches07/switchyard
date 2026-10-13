import { setTimeout as sleep } from "node:timers/promises";
import type { ChatRequest } from "../../core/chat.js";
import { upstreamClientError, upstreamError } from "../../core/errors.js";
import type { CallContext, ChatProvider, ChatResult } from "../../core/provider.js";
import { abortedCallError } from "./abort.js";

export interface MockProviderConfig {
  latencyMs: number;
  errorRate: number;
}

export interface MockProviderOptions {
  random?: () => number;
}

const CONTENT = "This is a mock response.";
const COMPLETION_TOKENS = 6;

/**
 * Deterministic provider for tests and benchmarks (spec 002, AC-10).
 * A model named `error-<status>` fails with that upstream status on demand.
 */
export function createMockProvider(
  name: string,
  config: MockProviderConfig,
  options: MockProviderOptions = {},
): ChatProvider {
  const random = options.random ?? Math.random;
  let counter = 0;

  return {
    name,
    type: "mock",
    async chat(request: ChatRequest, ctx: CallContext): Promise<ChatResult> {
      if (config.latencyMs > 0) {
        try {
          await sleep(config.latencyMs, undefined, { signal: ctx.signal });
        } catch {
          throw abortedCallError(name, ctx.signal);
        }
      }

      const forced = /^error-(\d{3})$/.exec(request.model)?.[1];
      if (forced) throw simulatedFailure(name, Number(forced));
      if (random() < config.errorRate) throw upstreamError(name);

      const inputTokens = Math.ceil(contentLength(request) / 4);
      counter += 1;
      return {
        body: {
          id: `chatcmpl-mock-${counter}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: CONTENT },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: COMPLETION_TOKENS,
            total_tokens: inputTokens + COMPLETION_TOKENS,
          },
        },
        usage: { inputTokens, outputTokens: COMPLETION_TOKENS },
        responseModel: request.model,
      };
    },
  };
}

function contentLength(request: ChatRequest): number {
  return request.messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
}

function simulatedFailure(provider: string, status: number) {
  if (status >= 500) return upstreamError(provider);
  if (status === 429) {
    return upstreamClientError(429, {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "Mock rate limit",
    });
  }
  return upstreamClientError(status, { message: `Mock failure with status ${status}` });
}
