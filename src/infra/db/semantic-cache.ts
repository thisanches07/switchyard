import { and, cosineDistance, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type {
  NewSemanticEntry,
  SemanticCacheStore,
  SemanticMatch,
  SemanticScope,
} from "../../core/cache.js";
import type { Database } from "./client.js";
import { semanticCacheEntries as entries } from "./schema.js";

/**
 * Semantic cache on pgvector (spec 009, ADR-0005, ADR-0009). The nearest-neighbour search runs
 * with HNSW iterative index scans, so a selective scope filter (team, models, params hash) still
 * finds its nearest entry instead of an empty result. Times come from the caller's clock.
 */
export class DrizzleSemanticCache implements SemanticCacheStore {
  constructor(private readonly db: Database) {}

  async nearest(
    scope: SemanticScope,
    embedding: readonly number[],
    now: Date,
  ): Promise<SemanticMatch | undefined> {
    if (scope.models.length === 0) return undefined;
    const distance = cosineDistance(entries.embedding, [...embedding]);
    return this.db.transaction(async (tx) => {
      // pgvector 0.8: keep scanning the index until enough rows pass the filter.
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);
      const [row] = await tx
        .select({ id: entries.id, model: entries.model, response: entries.response, distance })
        .from(entries)
        .where(
          and(
            eq(entries.teamId, scope.teamId),
            eq(entries.paramsHash, scope.paramsHash),
            inArray(entries.model, [...scope.models]),
            gt(entries.expiresAt, now),
          ),
        )
        .orderBy(distance)
        .limit(1);
      if (!row) return undefined;
      return {
        id: row.id,
        model: row.model,
        response: row.response,
        similarity: 1 - Number(row.distance),
      };
    });
  }

  async insert(entry: NewSemanticEntry): Promise<void> {
    await this.db.insert(entries).values({
      teamId: entry.teamId,
      model: entry.model,
      paramsHash: entry.paramsHash,
      embedding: [...entry.embedding],
      response: entry.response,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    });
  }

  async recordHit(id: string): Promise<void> {
    await this.db
      .update(entries)
      .set({ hits: sql`${entries.hits} + 1` })
      .where(eq(entries.id, id));
  }

  async deleteExpired(now: Date): Promise<number> {
    const deleted = await this.db
      .delete(entries)
      .where(lte(entries.expiresAt, now))
      .returning({ id: entries.id });
    return deleted.length;
  }
}
