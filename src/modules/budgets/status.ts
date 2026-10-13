/** Budget status of a key or team (spec 007, AC-12): `GET /admin/keys|teams/:id/budget`. */
import type { BudgetCounters, BudgetRef, BudgetStore } from "../../core/budget.js";
import { compare, decimal, mulInt, normalize, round, shift, sub } from "../pricing/decimal.js";
import { periodOf } from "./period.js";

export interface BudgetStatus {
  scope: BudgetRef["scope"];
  id: string;
  period: { start: string; end: string };
  limitUsd: string | null;
  softLimitPct: number;
  spentUsd: string;
  remainingUsd: string | null;
  softLimitReached: boolean;
  hardLimitReached: boolean;
  unknownCostRequests: number;
  /** Where `spentUsd` comes from: the hot counter, or Postgres when Redis is unavailable. */
  source: "redis" | "postgres";
}

/** Pure part: amounts and flags from a limit, a percentage and the spend. */
export function summarizeBudget(limitUsd: string | null, softLimitPct: number, spentUsd: string) {
  const spent = round(decimal(spentUsd), 10);
  if (limitUsd === null) {
    return {
      limitUsd: null,
      spentUsd: normalize(spent),
      remainingUsd: null,
      softLimitReached: false,
      hardLimitReached: false,
    };
  }
  const limit = decimal(limitUsd);
  const left = sub(limit, spent);
  return {
    limitUsd: normalize(limit),
    spentUsd: normalize(spent),
    remainingUsd: compare(left, decimal("0")) > 0 ? normalize(left) : "0",
    softLimitReached: compare(spent, shift(mulInt(limit, softLimitPct), 2)) >= 0,
    hardLimitReached: compare(spent, limit) >= 0,
  };
}

export async function budgetStatus(deps: {
  ref: BudgetRef;
  limitUsd: string | null;
  softLimitPct: number;
  counters: BudgetCounters;
  store: BudgetStore;
  now: number;
}): Promise<BudgetStatus> {
  const period = periodOf(deps.now);
  const stored = await deps.store.scopeSpend(deps.ref, period.startDay, period.endDay);
  let spentUsd = stored.spentUsd;
  let source: BudgetStatus["source"] = "postgres";
  try {
    const [hot] = await deps.counters.read(period.id, [deps.ref]);
    if (hot !== undefined) {
      decimal(hot);
      spentUsd = hot;
      source = "redis";
    }
  } catch {
    // Redis unavailable: the stored spend (which lags by the pipeline delay) is the answer.
  }
  return {
    scope: deps.ref.scope,
    id: deps.ref.id,
    period: { start: period.start, end: period.end },
    softLimitPct: deps.softLimitPct,
    unknownCostRequests: stored.unknownCostRequests,
    source,
    ...summarizeBudget(deps.limitUsd, deps.softLimitPct, spentUsd),
  };
}
