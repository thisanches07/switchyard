import { sql } from "drizzle-orm";
import type { BudgetRef, BudgetStore, StoredSpend } from "../../core/budget.js";
import type { Database } from "./client.js";

interface SpendRow extends Record<string, unknown> {
  scope: "key" | "team";
  id: string;
  spent_usd: string | null;
  unknown_cost_requests: string | number | null;
}

const toSpend = (row: SpendRow | undefined): StoredSpend => ({
  spentUsd: row?.spent_usd ?? "0",
  unknownCostRequests: Number(row?.unknown_cost_requests ?? 0),
});

/**
 * Spend and budgets on Postgres (spec 007): sums of `usage_daily` (exact `numeric`, ADR-0017)
 * for reconciliation and the budget status, and the keys and teams that have a budget.
 */
export class DrizzleBudgetStore implements BudgetStore {
  constructor(private readonly db: Database) {}

  async periodSpend(fromDay: string, toDay: string) {
    const range = sql`day >= ${fromDay}::date AND day < ${toDay}::date`;
    const { rows } = await this.db.execute<SpendRow>(sql`
      SELECT 'key' AS scope, key_id::text AS id, sum(cost_usd)::text AS spent_usd,
             sum(unknown_cost_requests) AS unknown_cost_requests
        FROM usage_daily WHERE ${range} GROUP BY key_id
      UNION ALL
      SELECT 'team' AS scope, team_id::text AS id, sum(cost_usd)::text AS spent_usd,
             sum(unknown_cost_requests) AS unknown_cost_requests
        FROM usage_daily WHERE ${range} GROUP BY team_id`);
    return rows.map((row) => ({ ref: { scope: row.scope, id: row.id }, ...toSpend(row) }));
  }

  async scopeSpend(ref: BudgetRef, fromDay: string, toDay: string): Promise<StoredSpend> {
    const column = ref.scope === "key" ? sql`key_id` : sql`team_id`;
    const { rows } = await this.db.execute<SpendRow>(sql`
      SELECT sum(cost_usd)::text AS spent_usd, sum(unknown_cost_requests) AS unknown_cost_requests
        FROM usage_daily
       WHERE ${column} = ${ref.id}::uuid AND day >= ${fromDay}::date AND day < ${toDay}::date`);
    return toSpend(rows[0]);
  }

  async listBudgets() {
    const { rows } = await this.db.execute<{
      scope: "key" | "team";
      id: string;
      limit_usd: string;
    }>(
      sql`
      SELECT 'key' AS scope, id::text AS id, monthly_budget_usd::text AS limit_usd
        FROM api_keys WHERE monthly_budget_usd IS NOT NULL AND status = 'active'
      UNION ALL
      SELECT 'team' AS scope, id::text AS id, monthly_budget_usd::text AS limit_usd
        FROM teams WHERE monthly_budget_usd IS NOT NULL`,
    );
    return rows.map((row) => ({ ref: { scope: row.scope, id: row.id }, limitUsd: row.limit_usd }));
  }
}
