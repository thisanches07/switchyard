import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetRef, BudgetStore, StoredSpend } from "../../../src/core/budget.js";
import { createLogger } from "../../../src/infra/logger.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";
import { createRatioGauge } from "../../../src/modules/budgets/gauge.js";
import { reconcileOnce, startReconciler } from "../../../src/modules/budgets/reconcile.js";
import { captureLogs } from "../../helpers/log-capture.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const EXPIRY = Date.parse("2026-11-08T00:00:00Z");
const key: BudgetRef = { scope: "key", id: "k1" };
const team: BudgetRef = { scope: "team", id: "t1" };

function fakeStore(
  spend: (StoredSpend & { ref: BudgetRef })[],
  budgets: { ref: BudgetRef; limitUsd: string }[] = [],
) {
  const calls: string[] = [];
  const store: BudgetStore & { failing: boolean } = {
    failing: false,
    async periodSpend(fromDay, toDay) {
      if (store.failing) throw new Error("postgres down");
      calls.push(`${fromDay}..${toDay}`);
      return spend;
    },
    async scopeSpend() {
      return { spentUsd: "0", unknownCostRequests: 0 };
    },
    async listBudgets() {
      return budgets;
    },
  };
  return { store, calls };
}

describe("reconcileOnce (spec 007, AC-10)", () => {
  it("raises lower counters of the current period to the stored spend, never lowers one", async () => {
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    await counters.charge("2026-10", [key], "5", EXPIRY); // Redis ahead of Postgres: kept
    const { store, calls } = fakeStore([
      { ref: key, spentUsd: "3.0000000000", unknownCostRequests: 0 },
      { ref: team, spentUsd: "7.2500000000", unknownCostRequests: 2 },
    ]);
    const result = await reconcileOnce({ store, counters, now: () => NOW });
    expect(result).toEqual({ raised: 1, scopes: 2 });
    expect(calls).toEqual(["2026-10-01..2026-11-01"]);
    expect(await counters.read("2026-10", [key, team])).toEqual(["5", "7.25"]);
  });

  it("restores enforcement after Redis lost its data", async () => {
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    const { store } = fakeStore([{ ref: team, spentUsd: "40", unknownCostRequests: 0 }]);
    await reconcileOnce({ store, counters, now: () => NOW });
    expect(await counters.read("2026-10", [team])).toEqual(["40"]);
  });

  it("replaces the used-ratio gauge with every budgeted scope", async () => {
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    const gauge = createRatioGauge({ now: () => NOW });
    gauge.track({ scope: "key", id: "cleared" }, "1", "2026-10", "1");
    const { store } = fakeStore(
      [{ ref: team, spentUsd: "5", unknownCostRequests: 0 }],
      [
        { ref: team, limitUsd: "10.0000" },
        { ref: key, limitUsd: "2.0000" },
      ],
    );
    await reconcileOnce({ store, counters, gauge, now: () => NOW });
    expect(gauge.observe()).toEqual([
      { scope: "team", id: "t1", ratio: 0.5 },
      { scope: "key", id: "k1", ratio: 0 },
    ]);
    gauge.close();
  });
});

describe("startReconciler (spec 007, AC-10)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at start and then every interval, logs failures and keeps going, stops", async () => {
    vi.useFakeTimers();
    const counters = new MemoryBudgetCounters({ now: () => NOW });
    const { store, calls } = fakeStore([{ ref: key, spentUsd: "1", unknownCostRequests: 0 }]);
    const logs = captureLogs();
    const reconciler = startReconciler({
      store,
      counters,
      now: () => NOW,
      intervalMs: 60_000,
      logger: createLogger({ level: "info", destination: logs.stream }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    store.failing = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "budget reconciliation failed" }),
    );

    store.failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);

    await reconciler.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(2);
  });
});
