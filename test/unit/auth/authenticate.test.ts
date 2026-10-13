import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
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
