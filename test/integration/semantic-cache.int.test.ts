import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CachedResponse, NewSemanticEntry } from "../../src/core/cache.js";
import { createDatabase } from "../../src/infra/db/client.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";
import { semanticCacheEntries } from "../../src/infra/db/schema.js";
import { DrizzleSemanticCache } from "../../src/infra/db/semantic-cache.js";

/** A 768-dimensional vector starting with `head`, zeros after. */
const vec = (...head: number[]) => [...head, ...new Array<number>(768 - head.length).fill(0)];

const response = (text: string): CachedResponse => ({
  v: 1,
  candidate: "mock/fast-model",
  body: { choices: [{ index: 0, message: { role: "assistant", content: text } }] },
  usage: { inputTokens: 2, outputTokens: 1 },
  estimated: false,
});

describe("DrizzleSemanticCache on pgvector (spec 009, AC-5, AC-6)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: DrizzleSemanticCache;
  let db: ReturnType<typeof createDatabase>;
  const now = new Date(Date.UTC(2026, 9, 13, 12));
  const later = new Date(now.getTime() + 3_600_000);
  const team = randomUUID();
  const hash = "a".repeat(64);
  const entry = (overrides: Partial<NewSemanticEntry>): NewSemanticEntry => ({
    teamId: team,
    model: "mock/fast-model",
    paramsHash: hash,
    embedding: vec(1, 0),
    response: response("Paris"),
    createdAt: now,
    expiresAt: later,
    ...overrides,
  });
  const scope = { teamId: team, models: ["mock/fast-model", "ollama/llama3.2"], paramsHash: hash };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
    pool = createPostgresPool(container.getConnectionUri());
    db = createDatabase(pool);
    await migrateDatabase(db);
    store = new DrizzleSemanticCache(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("finds the nearest unexpired entry within team, models and params hash", async () => {
    await store.insert(entry({}));
    await store.insert(entry({ embedding: vec(1, 1), response: response("far") }));
    await store.insert(entry({ teamId: randomUUID(), embedding: vec(1, 0.01) }));
    await store.insert(entry({ paramsHash: "b".repeat(64), embedding: vec(1, 0.01) }));
    await store.insert(entry({ model: "mock/other", embedding: vec(1, 0.01) }));
    await store.insert(entry({ embedding: vec(1, 0.01), expiresAt: now }));

    const match = await store.nearest(scope, vec(1, 0.02), now);
    expect(match?.model).toBe("mock/fast-model");
    expect(match?.response).toEqual(response("Paris"));
    expect(match?.similarity).toBeGreaterThan(0.999);
    expect(match?.similarity).toBeLessThanOrEqual(1);
    expect(await store.nearest({ ...scope, teamId: randomUUID() }, vec(1, 0), now)).toBeUndefined();
    expect(await store.nearest({ ...scope, models: [] }, vec(1, 0), now)).toBeUndefined();
  });

  it("never returns an expired entry and deletes expired ones", async () => {
    const own = randomUUID();
    await store.insert(entry({ teamId: own, expiresAt: new Date(now.getTime() + 1_000) }));
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(await store.nearest({ ...scope, teamId: own }, vec(1, 0), at(999))).toBeDefined();
    expect(await store.nearest({ ...scope, teamId: own }, vec(1, 0), at(1_000))).toBeUndefined();
    const deleted = await store.deleteExpired(at(1_000));
    expect(deleted).toBeGreaterThanOrEqual(2); // this one and the expired entry of the first test
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM semantic_cache_entries WHERE expires_at <= $1",
      [at(1_000)],
    );
    expect(rows[0].n).toBe(0);
  });

  it("counts hits", async () => {
    const own = randomUUID();
    await store.insert(entry({ teamId: own }));
    const match = await store.nearest({ ...scope, teamId: own }, vec(1, 0), now);
    await store.recordHit(match?.id as string);
    await store.recordHit(match?.id as string);
    const { rows } = await pool.query("SELECT hits FROM semantic_cache_entries WHERE id = $1", [
      match?.id,
    ]);
    expect(rows[0].hits).toBe(2);
  });

  it("still finds a team's entry among many nearer entries of other teams (iterative scan)", async () => {
    const target = randomUUID();
    // 1,200 entries of 300 other teams, all nearer to the query than the target entry.
    const others = Array.from({ length: 1_200 }, (_, i) => ({
      teamId: `00000000-0000-4000-8000-${String(i % 300).padStart(12, "0")}`,
      model: "mock/fast-model",
      paramsHash: hash,
      embedding: vec(1, (i % 50) / 1_000, (i % 7) / 1_000),
      response: response("other"),
      createdAt: now,
      expiresAt: later,
    }));
    for (let i = 0; i < others.length; i += 200) {
      await db.insert(semanticCacheEntries).values(others.slice(i, i + 200));
    }
    await store.insert(
      entry({ teamId: target, embedding: vec(1, 0.9), response: response("mine") }),
    );
    await pool.query("ANALYZE semantic_cache_entries");

    const match = await store.nearest({ ...scope, teamId: target }, vec(1, 0), now);
    expect(match?.response).toEqual(response("mine"));
  });
});
