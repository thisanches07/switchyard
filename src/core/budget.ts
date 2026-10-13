/**
 * Monthly budgets (spec 007, ADR-0017): scopes, hot counters in Redis (ADR-0006) and the stored
 * spend in Postgres that reconciliation reads. Money is always a decimal string.
 */

export type BudgetScope = "key" | "team";

export interface BudgetRef {
  scope: BudgetScope;
  id: string;
}

/**
 * Hot spend counters per period (ADR-0006, ADR-0017), implemented on Redis in production. Values
 * are decimal strings; Redis keeps them as floats, so they serve admission decisions only.
 */
export interface BudgetCounters {
  /** Spend of each ref in the period ("0" when there is no counter), in order. */
  read(period: string, refs: readonly BudgetRef[]): Promise<string[]>;
  /** Adds a known cost to every ref and returns the new totals; counters expire at `expireAtMs`. */
  charge(
    period: string,
    refs: readonly BudgetRef[],
    amountUsd: string,
    expireAtMs: number,
  ): Promise<string[]>;
  /** Sets each counter to max(current, spentUsd), never lowering one; returns how many rose. */
  raise(
    period: string,
    entries: readonly { ref: BudgetRef; spentUsd: string }[],
    expireAtMs: number,
  ): Promise<number>;
}

/** Stored spend of one scope over a range of days (from `usage_daily`, exact decimals). */
export interface StoredSpend {
  /** Sum of known costs, decimal string ("0" when none). */
  spentUsd: string;
  /** Requests whose cost is unknown: not part of `spentUsd`. */
  unknownCostRequests: number;
}

/** The source of truth for spend and the configured budgets (Postgres, spec 007). */
export interface BudgetStore {
  /** Spend per key and per team with usage on days in [fromDay, toDay) (`YYYY-MM-DD`, UTC). */
  periodSpend(fromDay: string, toDay: string): Promise<(StoredSpend & { ref: BudgetRef })[]>;
  /** One scope's spend on days in [fromDay, toDay). */
  scopeSpend(ref: BudgetRef, fromDay: string, toDay: string): Promise<StoredSpend>;
  /** Every key and team that has a monthly budget. */
  listBudgets(): Promise<{ ref: BudgetRef; limitUsd: string }[]>;
}
