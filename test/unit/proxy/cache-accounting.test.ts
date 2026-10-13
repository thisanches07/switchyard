import { SpanKind } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { decimal } from "../../../src/modules/pricing/decimal.js";
import { PriceTable } from "../../../src/modules/pricing/table.js";
import { cacheApp, fixedChatProvider } from "../../helpers/cache.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const NOW = Date.UTC(2026, 9, 13, 12);
const messages = [{ role: "user", content: "12345678" }]; // mock: 2 input, 6 output tokens
const ask = (extra: Record<string, unknown> = {}) => ({
  model: "fast",
  messages,
  temperature: 0,
  ...extra,
});
/** mock/* at $1 / $2 per 1M tokens; ollama has no price. */
const table = new PriceTable([["mock/*", { input: decimal("1"), output: decimal("2") }]]);

describe("cache hits: accounting and observability (spec 009, AC-8, AC-9, AC-13)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  let metrics: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    metrics = installTestMetrics();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await metrics.uninstall();
  });

  async function setup(options: Parameters<typeof cacheApp>[0] = {}) {
    const setup = await cacheApp({ costEstimator: table, clock: () => NOW, ...options });
    apps.push(setup.app);
    return setup;
  }

  const sum = async (name: string, labels: Record<string, string>) =>
    (await metrics.points(name))
      .filter((p) => Object.entries(labels).every(([k, v]) => p.attributes[k] === v))
      .reduce((total, p) => total + (p.value as number), 0);

  it("records a hit with attempts 0, cost 0 and the stored usage and candidate (AC-8)", async () => {
    const { chat, events } = await setup();
    const miss = await chat(ask());
    const hit = await chat(ask());
    expect(miss.headers["x-switchyard-cost-usd"]).toBe("0.0000140000");
    expect(hit.headers["x-switchyard-cost-usd"]).toBe("0");
    for (const event of events) expect(usageEventSchema.safeParse(event).success).toBe(true);
    expect(events[0]).toMatchObject({ cacheStatus: "miss", attempts: 1, costUsd: "0.0000140000" });
    expect(events[1]).toMatchObject({
      cacheStatus: "hit",
      attempts: 0,
      costUsd: "0",
      inputTokens: 2,
      outputTokens: 6,
      cachedInputTokens: 0,
      provider: "mock",
      servedModel: "fast-model",
      outcome: "success",
      status: 200,
      estimated: false,
    });
  });

  it("reports provider prompt-cache tokens on misses only (AC-8)", async () => {
    const fixed = fixedChatProvider("mock", () => ({
      body: {
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "fast-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 3 },
    }));
    const { chat, events, registry } = await setup();
    registry.set("mock", fixed.provider);
    await chat(ask());
    await chat(ask());
    expect(events.map((e: UsageEvent) => [e.cacheStatus, e.cachedInputTokens])).toEqual([
      ["miss", 3],
      ["hit", 0],
    ]);
  });

  it("reconciles the hit's token reservation to the stored usage (AC-8)", async () => {
    const store = new MemoryKeyStore();
    const limiter = new MemoryRateLimiter();
    const { chat } = await setup({ store, limiter, authenticated: false });
    const { key, record } = await store.issueKey({ team: "tpm", limits: { tpm: 10_000 } });
    const auth = { authorization: `Bearer ${key}` };
    await chat(ask({ max_tokens: 1_000 }), auth);
    const afterMiss = await limiter.peek(`sy:rl:key:${record.id}:tok`, 10_000);
    const hit = await chat(ask({ max_tokens: 1_000 }), auth);
    expect(hit.headers["x-switchyard-cache"]).toBe("hit");
    const afterHit = await limiter.peek(`sy:rl:key:${record.id}:tok`, 10_000);
    // Reserved 2 + 1000, reconciled to the stored 2 + 6.
    expect(afterMiss - afterHit).toBeGreaterThan(7);
    expect(afterMiss - afterHit).toBeLessThan(9);
  });

  it("adds 0 to the budget, and an exhausted budget gets no hit (AC-8)", async () => {
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    const store = new MemoryKeyStore();
    const { chat, spies } = await setup({ store, budgetCounters: counters, authenticated: false });
    const { key, record } = await store.issueKey({ team: "budget", budgetUsd: "0.00002" });
    const ref = { scope: "key" as const, id: record.id };
    const auth = { authorization: `Bearer ${key}` };
    await chat(ask(), auth);
    expect(await counters.read("2026-10", [ref])).toEqual(["0.000014"]);
    expect((await chat(ask(), auth)).headers["x-switchyard-cache"]).toBe("hit");
    expect(await counters.read("2026-10", [ref])).toEqual(["0.000014"]);
    await counters.charge("2026-10", [ref], "0.00001", NOW + 86_400_000 * 40);
    const refused = await chat(ask(), auth);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("budget_exceeded");
    expect(spies.mock?.requests).toHaveLength(1);
  });

  it("counts savings at the stored candidate's price, unknown prices apart (AC-9)", async () => {
    const { chat, key: _key } = await setup();
    await chat(ask());
    await chat(ask());
    await chat(ask());
    await chat(ask({ model: "ollama/llama3.2" }));
    await chat(ask({ model: "ollama/llama3.2" }));
    expect(
      await sum("switchyard_cache_savings_usd_total", { model: "mock/fast-model" }),
    ).toBeCloseTo(2 * 0.000014, 12);
    expect(
      await sum("switchyard_cache_savings_unknown_total", {
        model: "ollama/llama3.2",
        layer: "exact",
      }),
    ).toBe(1);
    expect(await sum("switchyard_cache_savings_usd_total", { model: "ollama/llama3.2" })).toBe(0);
  });

  it("labels requests_total with the cache status and counts lookups (AC-9)", async () => {
    const { chat } = await setup();
    await chat(ask());
    await chat(ask());
    await chat(ask({ temperature: 1 }));
    expect(await sum("switchyard_requests_total", { cache: "miss", provider: "mock" })).toBe(1);
    expect(
      await sum("switchyard_requests_total", { cache: "hit", provider: "mock", status: "200" }),
    ).toBe(1);
    expect(await sum("switchyard_requests_total", { cache: "bypass" })).toBe(1);
    expect(await sum("switchyard_cache_lookups_total", { layer: "exact", result: "miss" })).toBe(1);
    expect(await sum("switchyard_cache_lookups_total", { layer: "exact", result: "hit" })).toBe(1);
  });

  it("tags the request span without keys or content (AC-13)", async () => {
    const tracing = installInMemoryTracing();
    try {
      const { chat } = await setup();
      await chat(ask());
      await chat(ask());
      const roots = tracing.exporter
        .getFinishedSpans()
        .filter((s) => s.kind === SpanKind.SERVER || s.attributes["switchyard.cache.result"]);
      const results = roots.map((s) => s.attributes["switchyard.cache.result"]).filter(Boolean);
      expect(results).toEqual(["miss", "hit"]);
      const hitSpan = roots.find((s) => s.attributes["switchyard.cache.result"] === "hit");
      expect(hitSpan?.attributes["switchyard.cache.layer"]).toBe("exact");
      const all = JSON.stringify(tracing.exporter.getFinishedSpans().map((s) => s.attributes));
      expect(all).not.toContain("sy:cache");
      expect(all).not.toContain("12345678");
    } finally {
      await tracing.uninstall();
    }
  });
});
