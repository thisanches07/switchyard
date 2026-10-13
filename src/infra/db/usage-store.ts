import { type SQL, sql } from "drizzle-orm";
import type {
  UsageEvent,
  UsageGroupBy,
  UsageQuery,
  UsageReader,
  UsageReport,
  UsageStore,
  UsageTotals,
} from "../../core/usage.js";
import type { Database } from "./client.js";
import { usageEvents } from "./schema.js";

/** Rows per INSERT: 25 columns each stays far below Postgres' 65 535 parameters. */
const CHUNK = 1_000;

function toRow(event: UsageEvent): typeof usageEvents.$inferInsert {
  return {
    id: event.id,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    requestId: event.requestId,
    teamId: event.teamId,
    keyId: event.keyId,
    operation: event.operation,
    stream: event.stream,
    requestedModel: event.requestedModel,
    provider: event.provider,
    servedModel: event.servedModel,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: event.cachedInputTokens,
    estimated: event.estimated,
    costUsd: event.costUsd,
    status: event.status,
    outcome: event.outcome,
    errorCode: event.errorCode,
    latencyMs: event.latencyMs,
    ttfbMs: event.ttfbMs,
    attempts: event.attempts,
    cacheStatus: event.cacheStatus,
    piiDetections: event.piiDetections,
  };
}

/** SQL expression of each grouping on `usage_daily`. */
const DAILY_GROUP: Record<Exclude<UsageGroupBy, "provider">, SQL> = {
  team: sql`team_id::text`,
  key: sql`key_id::text`,
  model: sql`model`,
  day: sql`day::text`,
};

interface AggregateRow extends Record<string, unknown> {
  group: string | null;
  requests: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cost_usd: string | null;
  unknown_cost_requests: string | number | null;
}

function toTotals(row: AggregateRow | undefined): UsageTotals {
  return {
    requests: Number(row?.requests ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    costUsd: row?.cost_usd ?? "0",
    unknownCostRequests: Number(row?.unknown_cost_requests ?? 0),
  };
}

/** Usage tables on Postgres (spec 006): idempotent inserts, daily aggregates and reports. */
export class DrizzleUsageStore implements UsageStore, UsageReader {
  constructor(private readonly db: Database) {}

  async summarize(query: UsageQuery): Promise<UsageReport> {
    // `provider` is not in usage_daily: it comes from the events themselves (design §10).
    const fromEvents = query.groupBy === "provider";
    const filters = [
      fromEvents
        ? sql`occurred_at >= (${query.from}::date)::timestamp AT TIME ZONE 'UTC'
              AND occurred_at < (${query.to}::date + 1)::timestamp AT TIME ZONE 'UTC'`
        : sql`day BETWEEN ${query.from}::date AND ${query.to}::date`,
      ...(query.teamId ? [sql`team_id = ${query.teamId}::uuid`] : []),
      ...(query.keyId ? [sql`key_id = ${query.keyId}::uuid`] : []),
    ];
    const where = sql.join(filters, sql` AND `);
    const measures = fromEvents
      ? sql`count(*) AS requests, sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens, coalesce(sum(cost_usd), 0)::text AS cost_usd,
            count(*) FILTER (WHERE cost_usd IS NULL) AS unknown_cost_requests`
      : sql`sum(requests) AS requests, sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens, coalesce(sum(cost_usd), 0)::text AS cost_usd,
            sum(unknown_cost_requests) AS unknown_cost_requests`;
    const table = fromEvents ? sql`usage_events` : sql`usage_daily`;
    const group = query.groupBy === "provider" ? sql`provider` : DAILY_GROUP[query.groupBy];
    const order =
      query.groupBy === "day"
        ? sql`1 ASC`
        : sql`coalesce(sum(cost_usd), 0) DESC, 2 DESC, 1 ASC NULLS LAST`;

    const grouped = await this.db.execute<AggregateRow>(sql`
      SELECT ${group} AS "group", ${measures}
        FROM ${table} WHERE ${where}
       GROUP BY 1 ORDER BY ${order}`);
    const totals = await this.db.execute<AggregateRow>(sql`
      SELECT ${measures} FROM ${table} WHERE ${where}`);

    return {
      data: grouped.rows.map((row) => ({ group: row.group, ...toTotals(row) })),
      totals: toTotals(totals.rows[0]),
    };
  }

  async insertEvents(events: readonly UsageEvent[]): Promise<{ inserted: number }> {
    // The same id twice in one batch is one event.
    const unique = [...new Map(events.map((e) => [e.id, e] as const)).values()];
    return this.db.transaction(async (tx) => {
      if (unique.length === 0) {
        await tx.execute(sql`SELECT 1`);
        return { inserted: 0 };
      }
      const ids: string[] = [];
      for (let i = 0; i < unique.length; i += CHUNK) {
        const rows = await tx
          .insert(usageEvents)
          .values(unique.slice(i, i + CHUNK).map(toRow))
          .onConflictDoNothing({ target: usageEvents.id })
          .returning({ id: usageEvents.id });
        for (const row of rows) ids.push(row.id);
      }
      if (ids.length === 0) return { inserted: 0 };

      // Only rows this transaction inserted reach the aggregates: redeliveries count once (AC-9).
      await tx.execute(sql`
        INSERT INTO usage_daily AS d
          (day, team_id, key_id, model, requests, input_tokens, output_tokens, cost_usd,
           unknown_cost_requests)
        SELECT (occurred_at AT TIME ZONE 'UTC')::date,
               team_id,
               key_id,
               CASE WHEN provider IS NOT NULL AND served_model IS NOT NULL
                    THEN provider || '/' || served_model
                    ELSE requested_model END,
               count(*),
               sum(input_tokens),
               sum(output_tokens),
               coalesce(sum(cost_usd), 0),
               count(*) FILTER (WHERE cost_usd IS NULL)
          FROM usage_events
         WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])
         GROUP BY 1, 2, 3, 4
        ON CONFLICT (day, team_id, key_id, model) DO UPDATE SET
          requests = d.requests + excluded.requests,
          input_tokens = d.input_tokens + excluded.input_tokens,
          output_tokens = d.output_tokens + excluded.output_tokens,
          cost_usd = d.cost_usd + excluded.cost_usd,
          unknown_cost_requests = d.unknown_cost_requests + excluded.unknown_cost_requests
      `);
      return { inserted: ids.length };
    });
  }
}
