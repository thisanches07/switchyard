import { sql } from "drizzle-orm";
import type { UsageEvent, UsageStore } from "../../core/usage.js";
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

/** Usage tables on Postgres (spec 006): idempotent inserts and daily aggregates. */
export class DrizzleUsageStore implements UsageStore {
  constructor(private readonly db: Database) {}

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
