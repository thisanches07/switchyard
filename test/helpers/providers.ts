import type { ChatRequest, EmbeddingsRequest } from "../../src/core/chat.js";
import type { ChatProvider, ChatResult } from "../../src/core/provider.js";
import { createMockProvider } from "../../src/modules/providers/mock.js";

/** Wraps a provider and records every request it receives. */
export function spyProvider(inner: ChatProvider) {
  const requests: ChatRequest[] = [];
  const embeddingRequests: EmbeddingsRequest[] = [];
  const signals: AbortSignal[] = [];
  const provider: ChatProvider = {
    name: inner.name,
    type: inner.type,
    chat(request, ctx): Promise<ChatResult> {
      requests.push(request);
      signals.push(ctx.signal);
      return inner.chat(request, ctx);
    },
    chatStream(request, ctx) {
      requests.push(request);
      signals.push(ctx.signal);
      return inner.chatStream(request, ctx);
    },
    embeddings(request, ctx) {
      embeddingRequests.push(request);
      signals.push(ctx.signal);
      return inner.embeddings(request, ctx);
    },
  };
  return { provider, requests, embeddingRequests, signals };
}

/** Registry matching `testConfig()` provider names, all backed by spied mock providers. */
export function spiedRegistry() {
  const names = ["mock", "ollama", "openrouter", "claude"];
  const spies = Object.fromEntries(
    names.map((n) => [n, spyProvider(createMockProvider(n, { latencyMs: 0, errorRate: 0 }))]),
  );
  const registry = new Map(names.map((n) => [n, spies[n]?.provider as ChatProvider]));
  return { registry, spies };
}
