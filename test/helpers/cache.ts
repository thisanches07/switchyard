import type { LoadedConfig } from "../../src/config/load.js";
import type { ChatProvider, ChatResult } from "../../src/core/provider.js";
import type { UsageEvent } from "../../src/core/usage.js";
import { MemoryExactCache } from "../../src/infra/memory/exact-cache.js";
import { type TestAppOptions, testApp } from "./app.js";
import { testConfig } from "./config.js";
import { spiedRegistry } from "./providers.js";

/** `testConfig()` with the exact cache on (spec 009) and optional overrides. */
export function cacheConfig(
  cache: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): LoadedConfig {
  return testConfig({
    cache: { exact: { enabled: true, ttlSeconds: 60 }, ...cache },
    ...overrides,
  });
}

/** A test app with the exact cache on, spied mock providers and recorded usage events. */
export async function cacheApp(options: TestAppOptions = {}) {
  const { registry, spies } = spiedRegistry();
  const events: UsageEvent[] = [];
  const exact = new MemoryExactCache(options.clock ? { now: options.clock } : {});
  const setup = await testApp({
    config: cacheConfig(),
    providers: registry,
    exactCache: exact,
    usageRecorder: { record: (event) => events.push(event) },
    ...options,
  });
  const chat = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    setup.app.inject({ method: "POST", url: "/v1/chat/completions", payload, headers });
  return { ...setup, spies, events, exact, chat, registry };
}

/** A provider whose chat calls all return `result` (other calls fail). */
export function fixedChatProvider(name: string, result: () => ChatResult) {
  let calls = 0;
  const provider: ChatProvider = {
    name,
    type: "mock",
    async chat() {
      calls += 1;
      return result();
    },
    async chatStream() {
      throw new Error("not used");
    },
    async embeddings() {
      throw new Error("not used");
    },
  };
  return { provider, calls: () => calls };
}

/** `data:` payloads of an SSE body, without `[DONE]`. */
export const sseData = (body: string) =>
  body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
