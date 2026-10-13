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

  it("rejects non-positive limits at the database level", async () => {
    const team = await store.createTeam("checked");
    await expect(store.updateTeamLimits(team.id, { rpm: 0 })).rejects.toThrow();
  });
});
