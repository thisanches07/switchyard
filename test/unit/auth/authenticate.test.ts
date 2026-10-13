import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthRecord } from "../../../src/core/auth.js";
import { createAuthenticate } from "../../../src/modules/auth/authenticate.js";
import { AuthCache } from "../../../src/modules/auth/cache.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { MemoryKeyStore, TEST_PEPPER } from "../../helpers/memory-key-store.js";
import { spiedRegistry } from "../../helpers/providers.js";

const payload = { model: "fast", messages: [{ role: "user", content: "hi" }] };

describe("authentication on /v1/*", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup() {
    const store = new MemoryKeyStore();
    const { registry, spies } = spiedRegistry();
    const { app } = await testApp({ store, providers: registry, authenticated: false });
    apps.push(app);
    const chat = (authorization?: string, body: object = payload) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: body,
        headers: authorization === undefined ? {} : { authorization },
      });
    return { app, store, spies, chat };
  }

  const expect401 = (res: { statusCode: number; json(): { error: { code: string } } }) => {
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
  };

  it("accepts a valid key", async () => {
    const { store, chat } = await setup();
    const { key } = await store.issueKey();
    const res = await chat(`Bearer ${key}`);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["missing header", undefined],
    ["wrong scheme", "Basic abc"],
    ["not a Switchyard key", "Bearer sk-openai-123"],
    ["unknown key", "Bearer sk-sy-doesnotexist000000000000000000000000000000"],
  ])("rejects %s with 401 and never calls a provider", async (_label, header) => {
    const { chat, spies } = await setup();
    expect401(await chat(header));
    expect(Object.values(spies).every((s) => s.requests.length === 0)).toBe(true);
  });

  it("accepts the key in x-api-key, alone or matching the bearer (spec 014, AC-6)", async () => {
    const { app, store } = await setup();
    const { key } = await store.issueKey();
    const send = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/v1/chat/completions", payload, headers });
    expect((await send({ "x-api-key": key })).statusCode).toBe(200);
    expect((await send({ "x-api-key": key, authorization: `Bearer ${key}` })).statusCode).toBe(200);
    const other = (await store.issueKey()).key;
    expect401(await send({ "x-api-key": key, authorization: `Bearer ${other}` }));
  });

  it("rejects revoked keys", async () => {
    const { store, chat } = await setup();
    const { key, record } = await store.issueKey();
    await store.revokeKey(record.id);
    expect401(await chat(`Bearer ${key}`));
  });

  it("rejects expired keys, also when the key is already cached", async () => {
    const { store, chat } = await setup();
    const { key, record } = await store.issueKey({ expiresAt: new Date(Date.now() + 300) });
    expect((await chat(`Bearer ${key}`)).statusCode).toBe(200);
    expect(record.expiresAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 350));
    expect401(await chat(`Bearer ${key}`));
  });

  it("caches validated keys", async () => {
    const { store, chat } = await setup();
    const { key } = await store.issueKey();
    await chat(`Bearer ${key}`);
    await chat(`Bearer ${key}`);
    await chat(`Bearer ${key}`);
    expect(store.lookups).toBe(1);
  });

  it("protects every /v1 route", async () => {
    const { app } = await setup();
    expect401(await app.inject({ method: "GET", url: "/v1/models" }));
    expect401(await app.inject({ method: "POST", url: "/v1/embeddings", payload: {} }));
  });

  it("leaves health endpoints open", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  describe("allowed models", () => {
    it("returns 403 model_not_allowed outside the list", async () => {
      const { store, chat, spies } = await setup();
      const { key } = await store.issueKey({ allowedModels: ["local"] });
      const res = await chat(`Bearer ${key}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("model_not_allowed");
      expect(spies.mock?.requests).toHaveLength(0);
    });

    it("accepts aliases, resolved refs and provider wildcards", async () => {
      const { store, chat } = await setup();
      const byAlias = await store.issueKey({ team: "a", allowedModels: ["fast"] });
      const byRef = await store.issueKey({ team: "b", allowedModels: ["mock/fast-model"] });
      const byWildcard = await store.issueKey({ team: "c", allowedModels: ["mock/*"] });
      for (const { key } of [byAlias, byRef, byWildcard]) {
        expect((await chat(`Bearer ${key}`)).statusCode).toBe(200);
      }
    });

    it("applies to embeddings", async () => {
      const { app, store } = await setup();
      const { key } = await store.issueKey({ allowedModels: ["local"] });
      const res = await app.inject({
        method: "POST",
        url: "/v1/embeddings",
        payload: { model: "mock/e", input: "x" },
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("filters /v1/models to what the key may use", async () => {
      const { app, store } = await setup();
      const { key } = await store.issueKey({ allowedModels: ["fast", "ollama/*"] });
      const res = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${key}` },
      });
      const ids = (res.json() as { data: { id: string }[] }).data.map((m) => m.id);
      expect(ids).toEqual(["local", "fast", "ollama/llama3.2"]);
    });
  });
});

describe("auth-failure limit per client address (spec 005, AC-11)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(server: Record<string, unknown> = {}) {
    const store = new MemoryKeyStore();
    const { app } = await testApp({
      store,
      authenticated: false,
      config: testConfig({ limits: { authFailuresPerMinutePerIp: 3 }, server }),
    });
    apps.push(app);
    const get = (authorization: string | undefined, remoteAddress = "203.0.113.7", extra = {}) =>
      app.inject({
        method: "GET",
        url: "/v1/models",
        remoteAddress,
        headers: { ...(authorization ? { authorization } : {}), ...extra },
      });
    return { store, get };
  }

  const unknownKey = "Bearer sk-sy-unknownunknownunknownunknownunknown000000";

  it("answers 429 once an address used up its failures, without querying the store", async () => {
    const { store, get } = await setup();
    for (let i = 0; i < 3; i += 1) expect((await get(unknownKey)).statusCode).toBe(401);
    const lookups = store.lookups;
    const limited = await get(unknownKey);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limit_exceeded");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(store.lookups).toBe(lookups);
  });

  it("counts missing and malformed keys too", async () => {
    const { get } = await setup();
    await get(undefined);
    await get("Basic abc");
    await get("Bearer not-a-switchyard-key");
    expect((await get(undefined)).statusCode).toBe(429);
  });

  it("keeps serving keys that are already cached, and other addresses", async () => {
    const { store, get } = await setup();
    const { key } = await store.issueKey();
    expect((await get(`Bearer ${key}`)).statusCode).toBe(200); // now cached
    for (let i = 0; i < 4; i += 1) await get(unknownKey);
    expect((await get(`Bearer ${key}`)).statusCode).toBe(200);
    expect((await get(unknownKey, "198.51.100.9")).statusCode).toBe(401);
  });

  it("uses X-Forwarded-For only when server.trustProxy is true", async () => {
    const untrusted = await setup();
    for (let i = 0; i < 3; i += 1) {
      await untrusted.get(unknownKey, "10.0.0.1", { "x-forwarded-for": `198.51.100.${i}` });
    }
    expect((await untrusted.get(unknownKey, "10.0.0.1")).statusCode).toBe(429);

    const trusted = await setup({ trustProxy: true });
    for (let i = 0; i < 3; i += 1) {
      await trusted.get(unknownKey, "10.0.0.1", { "x-forwarded-for": `198.51.100.${i}` });
    }
    expect(
      (await trusted.get(unknownKey, "10.0.0.1", { "x-forwarded-for": "198.51.100.99" }))
        .statusCode,
    ).toBe(401);
  });
});

describe("principal (spec 010)", () => {
  it("carries the key's own PII mode, null when it uses the config default", async () => {
    const store = new MemoryKeyStore();
    const authenticate = createAuthenticate({
      store,
      pepper: TEST_PEPPER,
      cache: new AuthCache<AuthRecord>({ ttlMs: 1_000, maxEntries: 10 }),
    });
    const principalFor = async (key: string) => {
      const request = {
        headers: { authorization: `Bearer ${key}` },
        ip: "127.0.0.1",
        log: { child: () => request.log },
      } as unknown as FastifyRequest;
      await authenticate(request);
      return request.principal;
    };
    const blocked = await store.issueKey({ piiMode: "block" });
    const inherited = await store.issueKey();
    expect((await principalFor(blocked.key))?.piiMode).toBe("block");
    expect((await principalFor(inherited.key))?.piiMode).toBeNull();

    // Spec 007: budgets of the key and its team; a key uses its team's soft limit percentage.
    const budgeted = await store.issueKey({ team: "budgets", budgetUsd: "5" });
    await store.updateTeamLimits(budgeted.team.id, { monthlyBudgetUsd: "50", softLimitPct: 90 });
    expect((await principalFor(budgeted.key))?.budget).toEqual({
      keyUsd: "5",
      teamUsd: "50",
      softLimitPct: 90,
    });
    expect((await principalFor(inherited.key))?.budget).toEqual({
      keyUsd: null,
      teamUsd: null,
      softLimitPct: 80,
    });
  });
});
