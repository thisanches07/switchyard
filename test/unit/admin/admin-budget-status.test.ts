import { afterEach, describe, expect, it } from "vitest";
import type { BudgetRef, BudgetStore, StoredSpend } from "../../../src/core/budget.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";
import { testApp } from "../../helpers/app.js";
import { MemoryKeyStore, TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const EXPIRY = Date.parse("2026-11-08T00:00:00Z");
const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
const PERIOD = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" };

type SpendOf = (ref: BudgetRef) => StoredSpend | undefined;

/** Stored spend per scope; records the day ranges it was asked for. */
function fakeStore(spendOf: SpendOf) {
  const ranges: string[] = [];
  const store: BudgetStore = {
    async periodSpend() {
      return [];
    },
    async scopeSpend(ref: BudgetRef, fromDay: string, toDay: string) {
      ranges.push(`${fromDay}..${toDay}`);
      return spendOf(ref) ?? { spentUsd: "0", unknownCostRequests: 0 };
    },
    async listBudgets() {
      return [];
    },
  };
  return { store, ranges };
}

describe("GET /admin/keys|teams/:id/budget (spec 007, AC-12)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(spendOf: SpendOf = () => undefined, withStore = true) {
    const keys = new MemoryKeyStore();
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    const fake = fakeStore(spendOf);
    const { app } = await testApp({
      store: keys,
      budgetCounters: counters,
      clock: () => NOW,
      adminToken: TEST_ADMIN_TOKEN,
      authenticated: false,
      ...(withStore ? { budgetStore: fake.store } : {}),
    });
    apps.push(app);
    const { record, team } = await keys.issueKey({
      team: "status",
      budgetUsd: "10",
      teamLimits: { monthlyBudgetUsd: "100", softLimitPct: 50 },
    });
    const get = (url: string, headers: Record<string, string> = admin) =>
      app.inject({ method: "GET", url, headers });
    return { get, counters, keys, record, team, ranges: fake.ranges };
  }

  it("reports a key's budget from the Redis counter, unknown costs from Postgres", async () => {
    const { get, counters, record, ranges } = await setup();
    await counters.charge("2026-10", [{ scope: "key", id: record.id }], "6.0000140000", EXPIRY);
    const res = await get(`/admin/keys/${record.id}/budget`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scope: "key",
      id: record.id,
      period: PERIOD,
      limitUsd: "10",
      softLimitPct: 50,
      spentUsd: "6.000014",
      remainingUsd: "3.999986",
      softLimitReached: true,
      hardLimitReached: false,
      unknownCostRequests: 0,
      source: "redis",
    });
    expect(ranges).toEqual(["2026-10-01..2026-11-01"]);
  });

  it("reports a team's budget, hard limit and unknown-cost requests", async () => {
    const { get, counters, team } = await setup((ref) =>
      ref.scope === "team" ? { spentUsd: "149", unknownCostRequests: 7 } : undefined,
    );
    await counters.charge("2026-10", [{ scope: "team", id: team.id }], "150", EXPIRY);
    const res = await get(`/admin/teams/${team.id}/budget`);
    expect(res.json()).toMatchObject({
      scope: "team",
      id: team.id,
      limitUsd: "100",
      softLimitPct: 50,
      spentUsd: "150",
      remainingUsd: "0",
      softLimitReached: true,
      hardLimitReached: true,
      unknownCostRequests: 7,
      source: "redis",
    });
  });

  it("falls back to Postgres when Redis is unavailable", async () => {
    const keys = new MemoryKeyStore();
    const { record } = await keys.issueKey({ team: "fallback", budgetUsd: "10" });
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    counters.failing = true;
    const { store } = fakeStore((ref) =>
      ref.id === record.id ? { spentUsd: "2.5000000000", unknownCostRequests: 4 } : undefined,
    );
    const { app } = await testApp({
      store: keys,
      budgetCounters: counters,
      budgetStore: store,
      clock: () => NOW,
      adminToken: TEST_ADMIN_TOKEN,
      authenticated: false,
    });
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: `/admin/keys/${record.id}/budget`,
      headers: admin,
    });
    expect(res.json()).toMatchObject({
      spentUsd: "2.5",
      remainingUsd: "7.5",
      unknownCostRequests: 4,
      softLimitReached: false,
      hardLimitReached: false,
      source: "postgres",
    });
  });

  it("returns null limit and remaining without a budget", async () => {
    const { get, keys } = await setup();
    const { record } = await keys.issueKey({ team: "no-budget" });
    const res = await get(`/admin/keys/${record.id}/budget`);
    expect(res.json()).toMatchObject({
      limitUsd: null,
      remainingUsd: null,
      softLimitPct: 80,
      spentUsd: "0",
      softLimitReached: false,
      hardLimitReached: false,
    });
  });

  it("answers 404 for unknown ids, 401 without the admin token", async () => {
    const { get, record } = await setup();
    expect((await get("/admin/keys/00000000-0000-4000-8000-000000000000/budget")).statusCode).toBe(
      404,
    );
    expect((await get("/admin/teams/nope/budget")).json().error.code).toBe("not_found");
    expect((await get(`/admin/keys/${record.id}/budget`, {})).statusCode).toBe(401);
  });

  it("answers 503 usage_unavailable without a budget store", async () => {
    const { get, record } = await setup(() => undefined, false);
    const res = await get(`/admin/keys/${record.id}/budget`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("usage_unavailable");
  });
});
