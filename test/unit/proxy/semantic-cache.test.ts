import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySemanticCache } from "../../../src/infra/memory/semantic-cache.js";
import { cacheApp, cacheConfig, fakeEmbedder, vec } from "../../helpers/cache.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { manualTimers } from "../../helpers/routing.js";

const NOW = Date.UTC(2026, 9, 13, 12);

const TEXTS = {
  "What is the capital of France?": vec(1, 0),
  "capital of France?": vec(1, 0.1), // cosine ≈ 0.995
  "Tell me about Lyon": vec(1, 0.5), // cosine ≈ 0.894
};

const ask = (question: string, extra: Record<string, unknown> = {}) => ({
  model: "mock/fast-model",
  temperature: 0.2,
  messages: [
    { role: "system", content: "Answer in one word." },
    { role: "user", content: question },
  ],
  ...extra,
});

describe("semantic cache on /v1/chat/completions (spec 009, AC-5, AC-6, AC-12)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  let metrics: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    metrics = installTestMetrics();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await metrics.uninstall();
  });

  async function setup(
    options: {
      embedder?: ReturnType<typeof fakeEmbedder>;
      exact?: boolean;
      semantic?: Record<string, unknown>;
      timers?: ReturnType<typeof manualTimers>;
    } = {},
  ) {
    const store = new MemoryKeyStore();
    const semantic = new MemorySemanticCache();
    const embedder = options.embedder ?? fakeEmbedder(TEXTS);
    const config = cacheConfig({
      exact: { enabled: options.exact ?? false, ttlSeconds: 60 },
      semantic: { enabled: true, similarityThreshold: 0.95, ttlSeconds: 600, ...options.semantic },
    });
    const setup = await cacheApp({
      config,
      store,
      semanticCache: semantic,
      clock: () => NOW,
      authenticated: false,
      ...(options.timers && { routing: { timers: options.timers } }),
    });
    apps.push(setup.app);
    setup.registry.set("ollama", embedder.provider);
    const optedIn = await store.issueKey({ team: "sem", semanticCache: true });
    const optedOut = await store.issueKey({ team: "sem" });
    const as = (key: string) => ({ authorization: `Bearer ${key}` });
    const chat = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
      setup.chat(payload, { ...as(optedIn.key), ...headers });
    return { ...setup, chat, semantic, embedder, optedOut: as(optedOut.key) };
  }

  const sum = async (name: string, labels: Record<string, string>) =>
    (await metrics.points(name))
      .filter((p) => Object.entries(labels).every(([k, v]) => p.attributes[k] === v))
      .reduce((total, p) => total + (p.value as number), 0);

  it("serves a similar question from the cache above the threshold (AC-5)", async () => {
    const { chat, spies, semantic, events } = await setup();
    const first = await chat(ask("What is the capital of France?"));
    expect(first.headers["x-switchyard-cache"]).toBe("miss");
    const second = await chat(ask("capital of France?"));
    expect(second.headers).toMatchObject({
      "x-switchyard-cache": "semantic-hit",
      "x-switchyard-provider": "mock",
      "x-switchyard-model": "fast-model",
      "x-switchyard-attempts": "0",
    });
    expect(second.json().choices).toEqual(first.json().choices);
    expect(spies.mock?.requests).toHaveLength(1);
    expect(semantic.entries[0]?.hits).toBe(1);
    expect(events.map((e) => e.cacheStatus)).toEqual(["miss", "semantic_hit"]);
    expect(events[1]).toMatchObject({ attempts: 0, costUsd: "0" });
    expect(await sum("switchyard_cache_lookups_total", { layer: "semantic", result: "hit" })).toBe(
      1,
    );
  });

  it("stores the miss with its embedding, candidate and expiry (AC-6)", async () => {
    const { chat, semantic, embedder } = await setup();
    await chat(ask("What is the capital of France?"));
    expect(embedder.calls).toEqual([
      { model: "nomic-embed-text", input: "What is the capital of France?" },
    ]);
    expect(semantic.entries).toHaveLength(1);
    const [entry] = semantic.entries;
    expect(entry?.model).toBe("mock/fast-model");
    expect(entry?.embedding).toEqual(vec(1, 0));
    expect(entry?.createdAt).toEqual(new Date(NOW));
    expect(entry?.expiresAt).toEqual(new Date(NOW + 600_000));
    expect(entry?.paramsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("misses below the threshold and stores the new answer", async () => {
    const { chat, spies, semantic } = await setup();
    await chat(ask("What is the capital of France?"));
    const res = await chat(ask("Tell me about Lyon"));
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(2);
    expect(semantic.entries).toHaveLength(2);
  });

  it.each([
    [
      "another system prompt",
      {
        messages: [
          { role: "system", content: "Be verbose." },
          { role: "user", content: "capital of France?" },
        ],
      },
    ],
    ["another max_tokens", { max_tokens: 5 }],
    ["another candidate model", { model: "mock/other-model" }],
  ])("keeps %s out of the scope (ADR-0009)", async (_name, extra) => {
    const { chat } = await setup();
    await chat(ask("What is the capital of France?"));
    const res = await chat(ask("capital of France?", extra));
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    // The same question with the original scope is a hit, so only the scope differed.
    expect((await chat(ask("capital of France?"))).headers["x-switchyard-cache"]).toBe(
      "semantic-hit",
    );
  });

  it.each([
    ["a key that did not opt in", {}, true],
    ["an absent temperature", { temperature: undefined }, false],
    ["a temperature above maxTemperature", { temperature: 0.5 }, false],
    ["tools", { tools: [{ type: "function", function: { name: "f", parameters: {} } }] }, false],
  ])("does not look up with %s", async (_name, extra, optedOut) => {
    const setup_ = await setup();
    const headers = optedOut ? setup_.optedOut : {};
    await setup_.chat(ask("What is the capital of France?", extra), headers);
    const res = await setup_.chat(ask("capital of France?", extra), headers);
    expect(res.headers["x-switchyard-cache"]).toBe("bypass");
    expect(setup_.embedder.calls).toHaveLength(0);
    expect(setup_.semantic.entries).toHaveLength(0);
  });

  it("is not relaxed by x-switchyard-cache: force", async () => {
    const { chat, embedder } = await setup();
    const res = await chat(ask("capital of France?", { temperature: 0.9 }), {
      "x-switchyard-cache": "force",
    });
    expect(res.headers["x-switchyard-cache"]).toBe("bypass");
    expect(embedder.calls).toHaveLength(0);
  });

  it("checks the exact cache first, then the semantic cache", async () => {
    const { chat, spies } = await setup({ exact: true });
    await chat(ask("What is the capital of France?", { temperature: 0 }));
    const exact = await chat(ask("What is the capital of France?", { temperature: 0 }));
    expect(exact.headers["x-switchyard-cache"]).toBe("hit");
    const near = await chat(ask("capital of France?", { temperature: 0 }));
    expect(near.headers["x-switchyard-cache"]).toBe("semantic-hit");
    expect(spies.mock?.requests).toHaveLength(1);
  });

  it("skips the layer when the lookup times out, on the injected clock (AC-12)", async () => {
    const timers = manualTimers(NOW);
    const embedder = fakeEmbedder(TEXTS, async (_request, ctx) => {
      timers.advance(300); // the lookup budget (lookupTimeoutMs) runs out during the call
      return new Promise((_, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const { chat, spies, semantic } = await setup({ embedder, timers });
    const res = await chat(ask("What is the capital of France?"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(1);
    // No embedding: nothing stored.
    expect(semantic.entries).toHaveLength(0);
    expect(await sum("switchyard_cache_errors_total", { layer: "semantic", stage: "lookup" })).toBe(
      1,
    );
  });

  it.each([
    ["a 3-dimensional embedding", async () => ({ body: { data: [{ embedding: [1, 2, 3] }] } })],
    [
      "a failing embedding call",
      async () => {
        throw new Error("ollama down");
      },
    ],
    ["a malformed body", async () => ({ body: { data: [] } })],
  ])("skips the layer with %s (AC-12)", async (_name, behaviour) => {
    const { chat, spies, semantic } = await setup({ embedder: fakeEmbedder(TEXTS, behaviour) });
    const res = await chat(ask("What is the capital of France?"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(1);
    expect(semantic.entries).toHaveLength(0);
    expect(
      await sum("switchyard_cache_lookups_total", { layer: "semantic", result: "error" }),
    ).toBe(1);
  });

  it("skips the layer while Postgres fails (AC-12)", async () => {
    const { chat, semantic, logs } = await setup();
    semantic.failing = true;
    const res = await chat(ask("What is the capital of France?"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(await sum("switchyard_cache_errors_total", { layer: "semantic", stage: "lookup" })).toBe(
      1,
    );
    expect(await sum("switchyard_cache_errors_total", { layer: "semantic", stage: "write" })).toBe(
      1,
    );
    const warning = logs.find((l) => l.msg === "cache layer skipped");
    expect(warning).toMatchObject({ layer: "semantic" });
    expect(JSON.stringify(logs)).not.toContain("capital of France");
  });

  it("charges the embedding call to nobody: one usage event per request", async () => {
    const { chat, events, embedder } = await setup();
    await chat(ask("What is the capital of France?"));
    await chat(ask("capital of France?"));
    expect(embedder.calls).toHaveLength(2);
    expect(events.map((e) => e.operation)).toEqual(["chat", "chat"]);
  });
});
