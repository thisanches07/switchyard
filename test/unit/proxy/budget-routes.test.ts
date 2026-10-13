import { afterEach, describe, expect, it } from "vitest";
import type { BudgetRef } from "../../../src/core/budget.js";
import type { RateLimiter } from "../../../src/core/ratelimit.js";
import type { UsageEvent } from "../../../src/core/usage.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { MemoryKeyStore, TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";
import { spiedRegistry } from "../../helpers/providers.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const RESET = "2026-11-01T00:00:00.000Z";
const EXPIRY = Date.parse("2026-11-08T00:00:00Z");
const chat = { model: "fast", messages: [{ role: "user", content: "12345678" }] };

/** Counts limiter debits, to prove a budget rejection takes no rate-limit unit. */
function countingLimiter() {
  const inner = new MemoryRateLimiter();
  const counts = { take: 0 };
  const limiter: RateLimiter = {
    take: (buckets) => {
      counts.take += 1;
      return inner.take(buckets);
    },
    adjust: (a) => inner.adjust(a),
    peek: (k, c) => inner.peek(k, c),
  };
  return { limiter, counts };
}

describe("budget admission on /v1 routes (spec 007, AC-6/AC-8/AC-9/AC-11)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(
    options: {
      keyBudget?: string | null;
      teamBudget?: string | null;
      softLimitPct?: number;
      onRedisError?: "open" | "closed";
    } = {},
  ) {
    const store = new MemoryKeyStore();
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    const { registry, spies } = spiedRegistry();
    const { limiter, counts } = countingLimiter();
    const events: UsageEvent[] = [];
    const { app } = await testApp({
      store,
      providers: registry,
      limiter,
      budgetCounters: counters,
      clock: () => NOW,
      adminToken: TEST_ADMIN_TOKEN,
      usageRecorder: { record: (event) => events.push(event) },
      config: testConfig({ budgets: { onRedisError: options.onRedisError ?? "closed" } }),
      authenticated: false,
    });
    apps.push(app);
    const { key, record, team } = await store.issueKey({
      team: "budgets",
      limits: { rpm: 100 },
      budgetUsd: options.keyBudget ?? null,
      teamLimits: {
        monthlyBudgetUsd: options.teamBudget ?? null,
        softLimitPct: options.softLimitPct ?? 80,
      },
    });
    const keyRef: BudgetRef = { scope: "key", id: record.id };
    const teamRef: BudgetRef = { scope: "team", id: team.id };
    const spend = (ref: BudgetRef, usd: string) => counters.charge("2026-10", [ref], usd, EXPIRY);
    const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url,
        payload,
        headers: { authorization: `Bearer ${key}`, ...headers },
      });
    return { app, key, post, spend, keyRef, teamRef, record, counters, spies, counts, events };
  }

  it("rejects an exhausted key budget with 429 budget_exceeded before any provider call", async () => {
    const { post, spies, counts, events } = await setup({ keyBudget: "0" });
    const res = await post("/v1/chat/completions", chat);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: {
        type: "insufficient_quota",
        code: "budget_exceeded",
        message: `Monthly budget exhausted for this key. It resets at ${RESET}.`,
      },
    });
    expect(res.headers["x-should-retry"]).toBe("false");
    expect(res.headers["x-switchyard-budget-limit-usd"]).toBe("0");
    expect(res.headers["x-switchyard-budget-remaining-usd"]).toBe("0");
    expect(res.headers["x-switchyard-budget-reset"]).toBe(RESET);
    expect(res.headers["x-ratelimit-limit-requests"]).toBeUndefined();
    expect(spies.mock?.requests).toHaveLength(0);
    expect(counts.take).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("rejects on the team budget without revealing the team's amounts in the message", async () => {
    const { post, spend, teamRef } = await setup({ keyBudget: "100", teamBudget: "5" });
    await spend(teamRef, "5.0000000001");
    const res = await post("/v1/embeddings", { model: "mock/embed", input: "hi" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toBe(
      `Monthly budget exhausted for this team. It resets at ${RESET}.`,
    );
    // No amount of any scope: the only number is the reset time.
    expect(res.json().error.message.replace(RESET, "")).not.toMatch(/\d/);
    expect(res.headers["x-switchyard-budget-limit-usd"]).toBe("5");
  });

  it("admits under budget with headers of the scope with the lowest remaining budget", async () => {
    const { post, spend, keyRef } = await setup({ keyBudget: "10", teamBudget: "50" });
    await spend(keyRef, "1.25");
    const res = await post("/v1/chat/completions", chat);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-budget-limit-usd"]).toBe("10");
    expect(res.headers["x-switchyard-budget-remaining-usd"]).toBe("8.75");
    expect(res.headers["x-switchyard-budget-reset"]).toBe(RESET);
    expect(res.headers["x-switchyard-budget-warning"]).toBeUndefined();
    expect(res.headers["x-ratelimit-limit-requests"]).toBe("100");
  });

  it("sends the budget headers with a stream's first chunk", async () => {
    const { post } = await setup({ teamBudget: "3" });
    const res = await post("/v1/chat/completions", { ...chat, stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-switchyard-budget-remaining-usd"]).toBe("3");
  });

  it("warns past the soft limit and serves normally", async () => {
    const { post, spend, teamRef } = await setup({ teamBudget: "10", softLimitPct: 50 });
    await spend(teamRef, "5");
    const res = await post("/v1/chat/completions", chat);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-budget-warning"]).toBe("soft_limit_reached");
  });

  it("keeps the budget headers on an admitted request that fails upstream", async () => {
    const { post } = await setup({ keyBudget: "10" });
    const res = await post("/v1/chat/completions", { ...chat, model: "mock/error-500" });
    expect(res.statusCode).toBe(502);
    expect(res.headers["x-switchyard-budget-limit-usd"]).toBe("10");
  });

  it("answers /v1/messages in the Anthropic error shape", async () => {
    const { post } = await setup({ keyBudget: "0" });
    const res = await post("/v1/messages", { ...chat, max_tokens: 10 });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error", details: { error_code: "budget_exceeded" } },
    });
    expect(res.headers["x-should-retry"]).toBe("false");
    expect(res.headers["x-switchyard-budget-reset"]).toBe(RESET);
  });

  it("sends no budget headers and never reads counters without a budget", async () => {
    const { post, counters } = await setup();
    counters.failing = true;
    const res = await post("/v1/chat/completions", chat);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.headers).some((h) => h.startsWith("x-switchyard-budget"))).toBe(false);
  });

  it("fails closed with 503 budget_unavailable for budgeted keys by default", async () => {
    const { post, counters, spies } = await setup({ keyBudget: "10" });
    counters.failing = true;
    const res = await post("/v1/chat/completions", chat);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("budget_unavailable");
    expect(spies.mock?.requests).toHaveLength(0);
  });

  it("fails open when budgets.onRedisError is open", async () => {
    const { post, counters } = await setup({ keyBudget: "10", onRedisError: "open" });
    counters.failing = true;
    const res = await post("/v1/chat/completions", chat);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-budget-limit-usd"]).toBeUndefined();
  });

  it("applies a budget change to the next request on the same instance (AC-4)", async () => {
    const { app, post, record } = await setup();
    expect((await post("/v1/chat/completions", chat)).statusCode).toBe(200);
    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/keys/${record.id}`,
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      payload: { monthlyBudgetUsd: 0 },
    });
    expect(patched.statusCode).toBe(200);
    expect((await post("/v1/chat/completions", chat)).statusCode).toBe(429);
  });

  it("does not check budgets on GET /v1/models", async () => {
    const { app, key } = await setup({ keyBudget: "0" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
