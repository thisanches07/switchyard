import { afterEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../../../src/config/load.js";
import { upstreamTimeout } from "../../../src/core/errors.js";
import type { CostEstimator } from "../../../src/core/pricing.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { spiedRegistry } from "../../helpers/providers.js";

const messages = [{ role: "user", content: "hello" }];

function routingConfig(overrides: Record<string, unknown> = {}): LoadedConfig {
  return testConfig({
    aliases: {
      fast: { strategy: "priority", candidates: ["mock/fast-model", "ollama/llama3.2"] },
      resilient: { strategy: "priority", candidates: ["mock/error-503", "ollama/llama3.2"] },
      broken: { strategy: "priority", candidates: ["mock/error-500"] },
      picky: { strategy: "priority", candidates: ["mock/error-400", "ollama/llama3.2"] },
      cheap: { strategy: "lowest-cost", candidates: ["mock/pricey", "ollama/cheap"] },
      embed: { strategy: "priority", candidates: ["mock/error-503", "ollama/nomic-embed-text"] },
    },
    ...overrides,
  });
}

describe("routing on /v1/chat/completions and /v1/embeddings (spec 008)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(
    options: {
      config?: LoadedConfig;
      providers?: Map<string, ChatProvider>;
      store?: MemoryKeyStore;
      costEstimator?: CostEstimator;
    } = {},
  ) {
    const { registry, spies } = spiedRegistry();
    const events: UsageEvent[] = [];
    const { app, key } = await testApp({
      config: options.config ?? routingConfig(),
      providers: options.providers ?? registry,
      usageRecorder: { record: (event) => events.push(event) },
      ...(options.store && { store: options.store }),
      ...(options.costEstimator && { costEstimator: options.costEstimator }),
    });
    apps.push(app);
    const chat = (model: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model, messages },
        headers,
      });
    return { app, key, spies, events, chat };
  }

  const lastEvent = (events: UsageEvent[]) => {
    const event = events.at(-1) as UsageEvent;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    return event;
  };

  describe("allowed models per candidate (AC-1)", () => {
    async function withKey(allowedModels: string[]) {
      const store = new MemoryKeyStore();
      const ctx = await setup({ store });
      const { key } = await store.issueKey({ allowedModels });
      return { ...ctx, as: (model: string) => ctx.chat(model, { authorization: `Bearer ${key}` }) };
    }

    it("skips candidates the key may not use", async () => {
      const { as, spies } = await withKey(["ollama/*"]);
      const res = await as("fast");
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-provider"]).toBe("ollama");
      expect(res.headers["x-switchyard-attempts"]).toBe("1");
      expect(spies.mock?.requests).toHaveLength(0);
    });

    it("an allowed alias name allows every candidate", async () => {
      const { as } = await withKey(["fast"]);
      expect((await as("fast")).headers["x-switchyard-provider"]).toBe("mock");
    });

    it("403 model_not_allowed when no candidate is allowed, without calling a provider", async () => {
      const { as, spies, events } = await withKey(["mock/other-model"]);
      const res = await as("fast");
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("model_not_allowed");
      expect(Object.values(spies).every((s) => s.requests.length === 0)).toBe(true);
      expect(events).toHaveLength(0);
      expect(res.headers["x-switchyard-attempts"]).toBeUndefined();
    });

    it("/v1/models lists an alias when any of its candidates is allowed", async () => {
      const store = new MemoryKeyStore();
      const { app } = await setup({ store });
      const { key } = await store.issueKey({ allowedModels: ["ollama/*"] });
      const res = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${key}` },
      });
      const ids = res.json().data.map((m: { id: string }) => m.id);
      expect(ids).toContain("fast");
      expect(ids).not.toContain("broken");
    });
  });

  it("falls back to the next candidate; headers and usage event name it (AC-3, AC-10)", async () => {
    const { chat, spies, events } = await setup();
    const res = await chat("resilient");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-provider"]).toBe("ollama");
    expect(res.headers["x-switchyard-model"]).toBe("llama3.2");
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    expect(spies.mock?.requests.map((r) => r.model)).toEqual(["error-503"]);
    expect(lastEvent(events)).toMatchObject({
      outcome: "success",
      provider: "ollama",
      servedModel: "llama3.2",
      attempts: 2,
      requestedModel: "resilient",
    });
  });

  it("returns the last error after retry.maxAttempts attempts (AC-5)", async () => {
    const { chat, spies, events } = await setup();
    const res = await chat("broken");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_error");
    expect(res.headers["x-switchyard-attempts"]).toBe("3");
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(res.headers["x-switchyard-model"]).toBe("error-500");
    expect(spies.mock?.requests).toHaveLength(3);
    expect(lastEvent(events)).toMatchObject({
      outcome: "upstream_error",
      status: 502,
      attempts: 3,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("passes an upstream 429 through after the retries (AC-5)", async () => {
    const { chat } = await setup();
    const res = await chat("mock/error-429");
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-switchyard-attempts"]).toBe("3");
  });

  it("answers 504 upstream_timeout when the provider times out (AC-5)", async () => {
    const { registry } = spiedRegistry();
    const slow: ChatProvider = {
      ...(registry.get("ollama") as ChatProvider),
      chat: async () => {
        throw upstreamTimeout("ollama");
      },
    };
    registry.set("ollama", slow);
    const { chat } = await setup({ providers: registry });
    const res = await chat("ollama/llama3.2");
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe("upstream_timeout");
  });

  it("returns a non-retryable 4xx at once without trying other candidates (AC-3)", async () => {
    const { chat, spies } = await setup();
    const res = await chat("picky");
    expect(res.statusCode).toBe(400);
    expect(res.headers["x-switchyard-attempts"]).toBe("1");
    expect(spies.ollama?.requests).toHaveLength(0);
  });

  it("503 no_healthy_upstream with retry-after and attempts 0 once the breaker is open (AC-9)", async () => {
    const config = routingConfig({
      circuitBreaker: { failureThreshold: 1, openMs: 30_000 },
      retry: { maxAttempts: 1 },
    });
    const { chat, spies, events } = await setup({ config });
    expect((await chat("broken")).statusCode).toBe(502);
    const res = await chat("broken");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type: "server_error", code: "no_healthy_upstream" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(res.headers["x-switchyard-attempts"]).toBe("0");
    expect(res.headers["x-switchyard-provider"]).toBeUndefined();
    expect(spies.mock?.requests).toHaveLength(1);
    expect(lastEvent(events)).toMatchObject({
      outcome: "upstream_error",
      errorCode: "no_healthy_upstream",
      status: 503,
      attempts: 0,
      provider: null,
      servedModel: null,
    });
  });

  it("lowest-cost uses the cost estimator with the request estimate (AC-2)", async () => {
    const seen: string[] = [];
    const { chat } = await setup({
      costEstimator: {
        estimateUsd: (ref, usage) => {
          seen.push(ref);
          expect(usage.outputTokens).toBe(512);
          return ref === "ollama/cheap" ? 0.0001 : 0.01;
        },
      },
    });
    const res = await chat("cheap");
    expect(res.headers["x-switchyard-provider"]).toBe("ollama");
    expect(seen.sort()).toEqual(["mock/pricey", "ollama/cheap"]);
  });

  it("lowest-cost without an estimator keeps config order (spec open question 1)", async () => {
    const { chat } = await setup();
    expect((await chat("cheap")).headers["x-switchyard-provider"]).toBe("mock");
  });

  it("embeddings fall back like chat (AC-3, AC-10)", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "embed", input: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-provider"]).toBe("ollama");
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    expect(lastEvent(events)).toMatchObject({ operation: "embeddings", attempts: 2 });
  });
});
