/**
 * `switchyard_budget_used_ratio{scope,id}` (spec 007, AC-13): current-period spend ÷ budget, for
 * scopes that have a budget. The gateway feeds it from admission and charging; the worker
 * replaces it on each reconciliation. Series of another period are not reported (new month →
 * reset), and a scope seen without a budget is removed (cleared).
 */
import type { BudgetRef } from "../../core/budget.js";
import { periodOf } from "./period.js";
import { budgetMetrics } from "./telemetry.js";

interface Entry {
  ref: BudgetRef;
  limitUsd: string;
  period: string;
  ratio: number;
}

export interface RatioGauge {
  /** A scope with a budget, and its spend at admission. */
  track(ref: BudgetRef, limitUsd: string, period: string, spentUsd: string): void;
  /** A scope without a budget: its series disappears. */
  forget(ref: BudgetRef): void;
  /** A counter was charged to `spentUsd` (only scopes already tracked are updated). */
  charged(ref: BudgetRef, period: string, spentUsd: string): void;
  /** Replaces every series (worker reconciliation). */
  replace(
    period: string,
    entries: readonly { ref: BudgetRef; limitUsd: string; spentUsd: string }[],
  ): void;
  /** Series of the current period. */
  observe(): { scope: BudgetRef["scope"]; id: string; ratio: number }[];
  /** Stops reporting. */
  close(): void;
}

/** A budget of 0 is fully used by definition. */
export function usedRatio(spentUsd: string, limitUsd: string): number {
  const limit = Number(limitUsd);
  return limit > 0 ? Number(spentUsd) / limit : 1;
}

const refKey = (ref: BudgetRef) => `${ref.scope}:${ref.id}`;

export function createRatioGauge(
  options: { now?: () => number; maxEntries?: number } = {},
): RatioGauge {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 10_000;
  const entries = new Map<string, Entry>();

  const set = (entry: Entry) => {
    const key = refKey(entry.ref);
    entries.delete(key);
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, entry);
  };

  const gauge: RatioGauge = {
    track(ref, limitUsd, period, spentUsd) {
      set({ ref, limitUsd, period, ratio: usedRatio(spentUsd, limitUsd) });
    },
    forget(ref) {
      entries.delete(refKey(ref));
    },
    charged(ref, period, spentUsd) {
      const entry = entries.get(refKey(ref));
      if (entry && entry.period === period) entry.ratio = usedRatio(spentUsd, entry.limitUsd);
    },
    replace(period, list) {
      entries.clear();
      for (const { ref, limitUsd, spentUsd } of list) {
        set({ ref, limitUsd, period, ratio: usedRatio(spentUsd, limitUsd) });
      }
    },
    observe() {
      const current = periodOf(now()).id;
      return [...entries.values()]
        .filter((entry) => entry.period === current)
        .map((entry) => ({ scope: entry.ref.scope, id: entry.ref.id, ratio: entry.ratio }));
    },
    close() {
      stop();
    },
  };
  const stop = budgetMetrics.watchRatios(() => gauge.observe());
  return gauge;
}
