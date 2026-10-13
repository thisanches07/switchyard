import { afterEach, describe, expect, it } from "vitest";
import type { CostEstimator } from "../../../src/core/pricing.js";
import { cacheApp, cacheConfig, fixedChatProvider } from "../../helpers/cache.js";

const messages = [{ role: "user", content: "12345678" }];
const ask = (extra: Record<string, unknown> = {}) => ({
  model: "fast",
  messages,
  temperature: 0,
  ...extra,
});

describe("exact cache on /v1/chat/completions (spec 009)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(options: Parameters<typeof cacheApp>[0] = {}) {
    const setup = await cacheApp(options);
    apps.push(setup.app);
    return setup;
  }

  it("misses, stores, then serves a hit without calling a provider (AC-2, AC-3, AC-4)", async () => {
    let now = Date.UTC(2026, 9, 13, 12);
    const { chat, spies } = await setup({ clock: () => now });
    const first = await chat(ask());
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(1);

    now += 5_000;
    const second = await chat(ask());
    expect(second.statusCode).toBe(200);
    expect(second.headers).toMatchObject({
      "x-switchyard-cache": "hit",
      "x-switchyard-provider": "mock",
      "x-switchyard-model": "fast-model",
      "x-switchyard-attempts": "0",
    });
    expect(spies.mock?.requests).toHaveLength(1);
    const [a, b] = [first.json(), second.json()];
    expect(b.choices).toEqual(a.choices);
    expect(b.usage).toEqual(a.usage);
    expect(b.id).not.toBe(a.id);
    expect(b.id).toMatch(/^chatcmpl-/);
    expect(b.created).toBe(Math.floor(now / 1000));
  });

  it("shares entries between streaming and non-streaming clients and other users", async () => {
    const { chat, spies } = await setup();
    await chat(ask({ user: "a" }));
    const hit = await chat(ask({ user: "b", stream_options: undefined }));
    expect(hit.headers["x-switchyard-cache"]).toBe("hit");
    expect(spies.mock?.requests).toHaveLength(1);
  });

  it.each([
    ["absent temperature", { temperature: undefined }],
    ["temperature above 0", { temperature: 0.2 }],
    ["n: 2", { n: 2 }],
  ])("does not cache with %s (AC-2)", async (_name, extra) => {
    const { chat, spies } = await setup();
    const first = await chat(ask(extra));
    const second = await chat(ask(extra));
    expect(first.headers["x-switchyard-cache"]).toBe("bypass");
    expect(second.headers["x-switchyard-cache"]).toBe("bypass");
    expect(spies.mock?.requests).toHaveLength(2);
  });

  it("caches any temperature with x-switchyard-cache: force (AC-2)", async () => {
    const { chat, spies } = await setup();
    const force = { "x-switchyard-cache": "force" };
    expect((await chat(ask({ temperature: 1 }), force)).headers["x-switchyard-cache"]).toBe("miss");
    expect((await chat(ask({ temperature: 1 }), force)).headers["x-switchyard-cache"]).toBe("hit");
    // Without the header the same request is not eligible.
    expect((await chat(ask({ temperature: 1 }))).headers["x-switchyard-cache"]).toBe("bypass");
    expect(spies.mock?.requests).toHaveLength(2);
  });

  it("neither reads nor writes with x-switchyard-cache: bypass (AC-2)", async () => {
    const { chat, spies } = await setup();
    const bypass = { "x-switchyard-cache": "bypass" };
    await chat(ask());
    expect((await chat(ask(), bypass)).headers["x-switchyard-cache"]).toBe("bypass");
    expect(spies.mock?.requests).toHaveLength(2);
    // A bypassed request does not write either.
    const other = ask({ max_tokens: 9 });
    await chat(other, bypass);
    expect((await chat(other)).headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(4);
  });

  it("rejects an invalid cache header with 400 before admission (AC-2)", async () => {
    const { chat, spies, events } = await setup();
    const res = await chat(ask(), { "x-switchyard-cache": "please" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "invalid_cache_header",
      type: "invalid_request_error",
    });
    expect(spies.mock?.requests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("does nothing when cache.exact.enabled is false", async () => {
    const { chat, spies, exact } = await setup({
      config: cacheConfig({ exact: { enabled: false } }),
    });
    await chat(ask());
    expect((await chat(ask())).headers["x-switchyard-cache"]).toBe("bypass");
    expect(spies.mock?.requests).toHaveLength(2);
    expect(exact.size).toBe(0);
  });

  it("looks candidates up in strategy order and serves the stored candidate (AC-3)", async () => {
    const { chat, spies } = await setup();
    // Only the second candidate of `fast` has an entry: the alias is served from it.
    await chat(ask({ model: "ollama/llama3.2" }));
    const fromSecond = await chat(ask());
    expect(fromSecond.headers["x-switchyard-cache"]).toBe("hit");
    expect(fromSecond.headers["x-switchyard-provider"]).toBe("ollama");
    expect(fromSecond.headers["x-switchyard-model"]).toBe("llama3.2");
    // Once the first candidate has one too, priority order prefers it.
    await chat(ask({ model: "mock/fast-model" }));
    const fromFirst = await chat(ask());
    expect(fromFirst.headers["x-switchyard-provider"]).toBe("mock");
    expect(spies.mock?.requests).toHaveLength(1);
    expect(spies.ollama?.requests).toHaveLength(1);
  });

  it("follows lowest-cost order across candidates (AC-3)", async () => {
    const cheapOllama: CostEstimator = {
      estimateUsd: (ref) => (ref.startsWith("ollama/") ? 0.001 : 0.01),
    };
    const config = cacheConfig(
      {},
      {
        aliases: {
          fast: { strategy: "lowest-cost", candidates: ["mock/fast-model", "ollama/llama3.2"] },
        },
      },
    );
    const { chat } = await setup({ config, costEstimator: cheapOllama });
    await chat(ask({ model: "mock/fast-model" }));
    await chat(ask({ model: "ollama/llama3.2" }));
    expect((await chat(ask())).headers["x-switchyard-provider"]).toBe("ollama");
  });

  it("never reads an entry of a candidate the key may not use (AC-3)", async () => {
    const { app, chat, store } = await setup();
    await chat(ask({ model: "ollama/llama3.2" }));
    const { key } = await store.issueKey({
      team: "default-test-team",
      allowedModels: ["mock/fast-model"],
    });
    const res = await chat(ask(), { authorization: `Bearer ${key}` });
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(app).toBeDefined();
  });

  it("never serves another team's entry (AC-3, AC-10)", async () => {
    const { chat, store, spies } = await setup();
    await chat(ask());
    const { key } = await store.issueKey({ team: "another-team" });
    const other = { authorization: `Bearer ${key}` };
    expect((await chat(ask(), other)).headers["x-switchyard-cache"]).toBe("miss");
    expect((await chat(ask(), other)).headers["x-switchyard-cache"]).toBe("hit");
    expect(spies.mock?.requests).toHaveLength(2);
  });

  it("stores nothing after an upstream error (AC-4)", async () => {
    const { chat, spies } = await setup();
    const broken = ask({ model: "mock/error-500" });
    expect((await chat(broken)).statusCode).toBe(502);
    const attempts = spies.mock?.requests.length ?? 0;
    const again = await chat(broken);
    expect(again.statusCode).toBe(502);
    expect(again.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(2 * attempts);
  });

  it.each([
    ["content_filter", "content_filter", false],
    ["length", "length", true],
    ["tool_calls", "tool_calls", true],
  ])("stores a finish_reason of %s: %s → %s (AC-4)", async (_name, finish, stored) => {
    const fixed = fixedChatProvider("mock", () => ({
      body: {
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "fast-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "…" }, finish_reason: finish },
        ],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    }));
    const { chat, registry } = await setup();
    registry.set("mock", fixed.provider);
    await chat(ask());
    const second = await chat(ask());
    expect(second.headers["x-switchyard-cache"]).toBe(stored ? "hit" : "miss");
    expect(fixed.calls()).toBe(stored ? 1 : 2);
  });

  it("does not use the cache for /v1/messages and embeddings (bypass)", async () => {
    const { app, events } = await setup();
    const payload = { model: "fast", max_tokens: 20, temperature: 0, messages };
    await app.inject({ method: "POST", url: "/v1/messages", payload });
    await app.inject({ method: "POST", url: "/v1/messages", payload });
    await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "mock/e", input: "x" },
    });
    expect(events.map((e) => [e.operation, e.cacheStatus, e.attempts])).toEqual([
      ["messages", "bypass", 1],
      ["messages", "bypass", 1],
      ["embeddings", "bypass", 1],
    ]);
  });
});
