import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors.js";
import { createDatabase } from "../../src/infra/db/client.js";
import { DrizzleKeyStore } from "../../src/infra/db/key-store.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";

describe("Postgres: migrations and DrizzleKeyStore", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: DrizzleKeyStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
    pool = createPostgresPool(container.getConnectionUri());
    const db = createDatabase(pool);
    await migrateDatabase(db);
    store = new DrizzleKeyStore(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("creates the tables and is a no-op when run again", async () => {
    await migrateDatabase(createDatabase(pool));
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "api_keys",
      "semantic_cache_entries",
      "teams",
      "usage_daily",
      "usage_events",
    ]);
  });

  it("creates, lists and fetches teams; duplicates are a 409", async () => {
    const team = await store.createTeam("platform");
    expect(team).toMatchObject({ name: "platform" });
    expect(team.createdAt).toBeInstanceOf(Date);
    expect(await store.getTeam(team.id)).toEqual(team);
    expect((await store.listTeams()).map((t) => t.name)).toContain("platform");

    const error = await store.createTeam("platform").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(409);
  });

  it("returns undefined for unknown or malformed team ids", async () => {
    expect(await store.getTeam("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(await store.getTeam("not-a-uuid")).toBeUndefined();
  });

  it("stores keys by hash and finds them", async () => {
    const team = await store.createTeam("search");
    const hash = "a".repeat(64);
    const created = await store.createKey({
      teamId: team.id,
      name: "web",
      hash,
      prefix: "sk-sy-abcd",
      allowedModels: ["fast", "ollama/*"],
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(created).toMatchObject({
      teamId: team.id,
      name: "web",
      prefix: "sk-sy-abcd",
      allowedModels: ["fast", "ollama/*"],
      status: "active",
      revokedAt: null,
    });
    expect(created).not.toHaveProperty("hash");
    expect(await store.findKeyByHash(hash)).toEqual({ key: created, team });
    expect(await store.findKeyByHash("b".repeat(64))).toBeUndefined();
    expect((await store.listKeys(team.id)).map((k) => k.id)).toEqual([created.id]);
  });

  it("revokes idempotently", async () => {
    const team = await store.createTeam("billing");
    const key = await store.createKey({
      teamId: team.id,
      name: "cron",
      hash: "c".repeat(64),
      prefix: "sk-sy-cccc",
      allowedModels: null,
      expiresAt: null,
    });
    const first = await store.revokeKey(key.id);
    const second = await store.revokeKey(key.id);
    expect(first?.status).toBe("revoked");
    expect(first?.revokedAt).toBeInstanceOf(Date);
    expect(second?.revokedAt).toEqual(first?.revokedAt);
    expect(await store.revokeKey("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(await store.revokeKey("nope")).toBeUndefined();
  });

  it("stores per-minute limits on teams and keys and joins them for auth (spec 005)", async () => {
    const team = await store.createTeam("limited", { rpm: 600, tpm: null });
    expect(team).toMatchObject({ rpm: 600, tpm: null });
    const key = await store.createKey({
      teamId: team.id,
      name: "app",
      hash: "d".repeat(64),
      prefix: "sk-sy-dddd",
      allowedModels: null,
      expiresAt: null,
      rpm: 60,
      tpm: 10_000,
    });
    expect(key).toMatchObject({ rpm: 60, tpm: 10_000 });
    expect(await store.findKeyByHash("d".repeat(64))).toMatchObject({
      key: { id: key.id, rpm: 60, tpm: 10_000 },
      team: { id: team.id, rpm: 600, tpm: null },
    });
  });

  it("updates and clears limits; omitted fields stay unchanged", async () => {
    const team = await store.createTeam("patchable");
    const key = await store.createKey({
      teamId: team.id,
      name: "app",
      hash: "e".repeat(64),
      prefix: "sk-sy-eeee",
      allowedModels: null,
      expiresAt: null,
      rpm: 10,
      tpm: 100,
    });
    expect(await store.updateKeyLimits(key.id, { rpm: 20 })).toMatchObject({ rpm: 20, tpm: 100 });
    expect(await store.updateKeyLimits(key.id, { tpm: null })).toMatchObject({
      rpm: 20,
      tpm: null,
    });
    expect(await store.updateTeamLimits(team.id, { tpm: 5_000 })).toMatchObject({
      rpm: null,
      tpm: 5_000,
    });
    expect(
      await store.updateKeyLimits("00000000-0000-0000-0000-000000000000", { rpm: 1 }),
    ).toBeUndefined();
    expect(await store.updateTeamLimits("nope", { rpm: 1 })).toBeUndefined();
  });

  it("adds the semantic cache opt-in and table with its indexes (spec 009, AC-1)", async () => {
    const column = await pool.query(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'api_keys' AND column_name = 'semantic_cache_enabled'",
    );
    expect(column.rows).toEqual([
      { data_type: "boolean", is_nullable: "NO", column_default: "false" },
    ]);
    const columns = await pool.query<{ column_name: string; udt_name: string }>(
      "SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'semantic_cache_entries' ORDER BY ordinal_position",
    );
    expect(columns.rows.map((r) => [r.column_name, r.udt_name])).toEqual([
      ["id", "uuid"],
      ["team_id", "uuid"],
      ["model", "text"],
      ["params_hash", "bpchar"],
      ["embedding", "vector"],
      ["response", "jsonb"],
      ["created_at", "timestamptz"],
      ["expires_at", "timestamptz"],
      ["hits", "int4"],
    ]);
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'semantic_cache_entries' ORDER BY indexname",
    );
    const defs = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.semantic_cache_entries_embedding_idx).toContain(
      "USING hnsw (embedding vector_cosine_ops)",
    );
    expect(defs.semantic_cache_entries_expires_at_idx).toContain("USING btree (expires_at)");
    expect(defs.semantic_cache_entries_scope_idx).toContain("USING btree (team_id, params_hash)");
    // vector(768): another dimension is refused.
    await expect(
      pool.query(
        "INSERT INTO semantic_cache_entries (team_id, model, params_hash, embedding, response, expires_at) VALUES (gen_random_uuid(), 'm/x', repeat('a', 64), '[1,2,3]', '{}', now())",
      ),
    ).rejects.toThrow(/dimensions/);

    const team = await store.createTeam("semantic");
    const key = await store.createKey({
      teamId: team.id,
      name: "opted",
      hash: "5".repeat(64),
      prefix: "sk-sy-5555",
      allowedModels: null,
      expiresAt: null,
      semanticCacheEnabled: true,
    });
    expect(key.semanticCacheEnabled).toBe(true);
    expect((await store.findKeyByHash("5".repeat(64)))?.key.semanticCacheEnabled).toBe(true);
    expect(await store.updateKeyLimits(key.id, { semanticCacheEnabled: false })).toMatchObject({
      semanticCacheEnabled: false,
    });
  });

  it("stores, updates and clears the key's PII mode (spec 010)", async () => {
    const { rows } = await pool.query<{ is_nullable: string; udt_name: string }>(
      "SELECT is_nullable, udt_name FROM information_schema.columns WHERE table_name = 'api_keys' AND column_name = 'pii_mode'",
    );
    expect(rows).toEqual([{ is_nullable: "YES", udt_name: "pii_mode" }]);

    const team = await store.createTeam("pii");
    const base = { teamId: team.id, name: "app", allowedModels: null, expiresAt: null };
    const inherited = await store.createKey({
      ...base,
      hash: "f".repeat(64),
      prefix: "sk-sy-ffff",
    });
    expect(inherited.piiMode).toBeNull();
    const masked = await store.createKey({
      ...base,
      hash: "1".repeat(64),
      prefix: "sk-sy-1111",
      piiMode: "mask",
      rpm: 3,
    });
    expect(masked.piiMode).toBe("mask");
    expect((await store.findKeyByHash("1".repeat(64)))?.key.piiMode).toBe("mask");

    expect(await store.updateKeyLimits(masked.id, { piiMode: "block" })).toMatchObject({
      piiMode: "block",
      rpm: 3,
    });
    expect(await store.updateKeyLimits(masked.id, { piiMode: null })).toMatchObject({
      piiMode: null,
      rpm: 3,
    });
    await expect(
      pool.query("UPDATE api_keys SET pii_mode = 'redact' WHERE id = $1", [masked.id]),
    ).rejects.toThrow();
  });

  it("adds budget columns with their defaults and checks (spec 007, AC-4)", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable,
              column_default
         FROM information_schema.columns
        WHERE column_name IN ('monthly_budget_usd', 'soft_limit_pct')
        ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      {
        table_name: "api_keys",
        column_name: "monthly_budget_usd",
        data_type: "numeric",
        numeric_precision: 12,
        numeric_scale: 4,
        is_nullable: "YES",
        column_default: null,
      },
      {
        table_name: "teams",
        column_name: "monthly_budget_usd",
        data_type: "numeric",
        numeric_precision: 12,
        numeric_scale: 4,
        is_nullable: "YES",
        column_default: null,
      },
      {
        table_name: "teams",
        column_name: "soft_limit_pct",
        data_type: "integer",
        numeric_precision: 32,
        numeric_scale: 0,
        is_nullable: "NO",
        column_default: "80",
      },
    ]);

    const team = await store.createTeam("budgeted", { monthlyBudgetUsd: "250.5" });
    expect(team).toMatchObject({ monthlyBudgetUsd: "250.5", softLimitPct: 80 });
    const key = await store.createKey({
      teamId: team.id,
      name: "app",
      hash: "2".repeat(64),
      prefix: "sk-sy-2222",
      allowedModels: null,
      expiresAt: null,
      monthlyBudgetUsd: "0",
    });
    expect(key.monthlyBudgetUsd).toBe("0");
    expect(await store.getKey(key.id)).toEqual(key);
    expect(await store.getKey("nope")).toBeUndefined();
    expect(await store.findKeyByHash("2".repeat(64))).toMatchObject({
      key: { monthlyBudgetUsd: "0" },
      team: { monthlyBudgetUsd: "250.5", softLimitPct: 80 },
    });

    expect(await store.updateKeyLimits(key.id, { monthlyBudgetUsd: "12.3456" })).toMatchObject({
      monthlyBudgetUsd: "12.3456",
    });
    expect(await store.updateKeyLimits(key.id, { monthlyBudgetUsd: null })).toMatchObject({
      monthlyBudgetUsd: null,
    });
    expect(await store.updateTeamLimits(team.id, { softLimitPct: 95 })).toMatchObject({
      monthlyBudgetUsd: "250.5",
      softLimitPct: 95,
    });
    expect(
      await store.updateTeamLimits(team.id, { monthlyBudgetUsd: "99999999.9999" }),
    ).toMatchObject({ monthlyBudgetUsd: "99999999.9999" });

    await expect(store.updateTeamLimits(team.id, { softLimitPct: 0 })).rejects.toThrow();
    await expect(store.updateTeamLimits(team.id, { softLimitPct: 101 })).rejects.toThrow();
    await expect(store.updateTeamLimits(team.id, { monthlyBudgetUsd: "-1" })).rejects.toThrow();
  });

  it("rejects non-positive limits at the database level", async () => {
    const team = await store.createTeam("checked");
    await expect(store.updateTeamLimits(team.id, { rpm: 0 })).rejects.toThrow();
  });
});
