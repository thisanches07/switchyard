import { afterEach, describe, expect, it } from "vitest";
import type { Limits } from "../../../src/core/auth.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { testApp } from "../../helpers/app.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { spiedRegistry } from "../../helpers/providers.js";

const messages = [{ role: "user", content: "12345678" }]; // 2 input tokens

describe("rate limits on /v1 routes", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(limits: Partial<Limits>) {
    const store = new MemoryKeyStore();
    const limiter = new MemoryRateLimiter();
    const { registry, spies } = spiedRegistry();
    const { app } = await testApp({ store, limiter, providers: registry, authenticated: false });
    apps.push(app);
    const { key, record } = await store.issueKey({ team: "limited", limits });
    const call = (url: string, payload: object) =>
      app.inject({
        method: "POST",
        url,
        payload,
        headers: { authorization: `Bearer ${key}` },
      });
    return { call, spies, limiter, record };
  }

  it("admits up to the RPM, then 429 with retry-after without calling the provider", async () => {
    const { call, spies } = await setup({ rpm: 2 });
    const body = { model: "fast", messages };
    const first = await call("/v1/chat/completions", body);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-limit-requests"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining-requests"]).toBe("1");
    expect((await call("/v1/chat/completions", body)).statusCode).toBe(200);

    const third = await call("/v1/chat/completions", body);
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatchObject({ type: "requests", code: "rate_limit_exceeded" });
    expect(Number(third.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(third.headers["x-ratelimit-remaining-requests"]).toBe("0");
    expect(spies.mock?.requests).toHaveLength(2);
  });

  it("returns 400 when a single request can never fit the token limit", async () => {
    const { call, spies } = await setup({ tpm: 100 });
    const res = await call("/v1/chat/completions", { model: "fast", messages, max_tokens: 500 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request_too_large_for_limit");
    expect(spies.mock?.requests).toHaveLength(0);
  });

  it("reconciles the token reservation with the provider usage", async () => {
    const { call, limiter, record } = await setup({ tpm: 10_000 });
    const res = await call("/v1/chat/completions", { model: "fast", messages, max_tokens: 1_000 });
    expect(res.statusCode).toBe(200);
    // Reserved 2 + 1000; mock reports 2 + 6 = 8 used: the rest is refunded.
    const level = await limiter.peek(`sy:rl:key:${record.id}:tok`, 10_000);
    expect(level).toBeGreaterThan(9_990);
    expect(level).toBeLessThanOrEqual(10_000);
  });

  it("refunds the whole token reservation when the provider fails", async () => {
    const { call, limiter, record } = await setup({ tpm: 10_000 });
    const res = await call("/v1/chat/completions", { model: "mock/error-500", messages });
    expect(res.statusCode).toBe(502);
    expect(await limiter.peek(`sy:rl:key:${record.id}:tok`, 10_000)).toBeCloseTo(10_000, 0);
  });

  it("limits embeddings with an input-only estimate", async () => {
    const { call } = await setup({ rpm: 1, tpm: 1_000 });
    const ok = await call("/v1/embeddings", { model: "mock/e", input: "hello" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-ratelimit-limit-tokens"]).toBe("1000");
    expect((await call("/v1/embeddings", { model: "mock/e", input: "hello" })).statusCode).toBe(
      429,
    );
  });

  it("applies to streaming requests too", async () => {
    const { call } = await setup({ rpm: 1 });
    const body = { model: "fast", messages, stream: true };
    const first = await call("/v1/chat/completions", body);
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-remaining-requests"]).toBe("0");
    expect((await call("/v1/chat/completions", body)).statusCode).toBe(429);
  });

  it("sends no rate limit headers when the key is unlimited", async () => {
    const { call } = await setup({});
    const res = await call("/v1/chat/completions", { model: "fast", messages });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.headers).some((h) => h.startsWith("x-ratelimit"))).toBe(false);
  });
});
