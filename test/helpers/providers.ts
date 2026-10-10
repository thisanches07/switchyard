import type { ChatRequest } from "../../src/core/chat.js";
import type { ChatProvider, ChatResult } from "../../src/core/provider.js";
import { createMockProvider } from "../../src/modules/providers/mock.js";

/** Wraps a provider and records every request it receives. */
export function spyProvider(inner: ChatProvider) {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    name: inner.name,
    type: inner.type,
    chat(request, ctx): Promise<ChatResult> {
      requests.push(request);
      return inner.chat(request, ctx);
    },
  };
  return { provider, requests };
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
