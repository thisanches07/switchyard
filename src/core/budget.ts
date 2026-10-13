/**
 * Monthly budgets (spec 007, ADR-0017): scopes, hot counters in Redis (ADR-0006) and the stored
 * spend in Postgres that reconciliation reads. Money is always a decimal string.
 */

export type BudgetScope = "key" | "team";

export interface BudgetRef {
  scope: BudgetScope;
  id: string;
}
