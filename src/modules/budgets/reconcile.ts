/**
 * Budget reconciliation (spec 007, AC-10; ADR-0017), run by the usage worker: raises each Redis
 * counter of the current period to the spend stored in Postgres, never lowering one. Postgres
 * lags the hot path and misses events dropped during a broker outage, so overwriting would erase
 * real spend; raising repairs lost counters (Redis restart, flush, expiry).
 */
import type { FastifyBaseLogger } from "fastify";
import type { BudgetCounters, BudgetStore } from "../../core/budget.js";
import type { RatioGauge } from "./gauge.js";
import { counterExpiry, periodOf } from "./period.js";

export interface ReconcileDeps {
  store: BudgetStore;
  counters: BudgetCounters;
  /** Refreshed with every budgeted scope after the counters are repaired (AC-13). */
  gauge?: RatioGauge;
  now?: () => number;
}

export async function reconcileOnce(
  deps: ReconcileDeps,
): Promise<{ raised: number; scopes: number }> {
  const period = periodOf((deps.now ?? Date.now)());
  const spend = await deps.store.periodSpend(period.startDay, period.endDay);
  const raised = await deps.counters.raise(
    period.id,
    spend.map(({ ref, spentUsd }) => ({ ref, spentUsd })),
    counterExpiry(period),
  );
  if (deps.gauge) {
    const budgets = await deps.store.listBudgets();
    const spent = await deps.counters.read(
      period.id,
      budgets.map((b) => b.ref),
    );
    deps.gauge.replace(
      period.id,
      budgets.map((b, i) => ({ ref: b.ref, limitUsd: b.limitUsd, spentUsd: spent[i] ?? "0" })),
    );
  }
  return { raised, scopes: spend.length };
}

/** Runs `reconcileOnce` now and then every `intervalMs`, one run at a time. */
export function startReconciler(
  deps: ReconcileDeps & { intervalMs: number; logger: FastifyBaseLogger },
): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const run = async () => {
    try {
      const { raised, scopes } = await reconcileOnce(deps);
      if (raised > 0) deps.logger.info({ raised, scopes }, "budget counters reconciled");
    } catch (error) {
      deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "budget reconciliation failed",
      );
    }
  };
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = run().finally(() => schedule(deps.intervalMs));
    }, delayMs);
    timer.unref();
  };
  schedule(0);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
