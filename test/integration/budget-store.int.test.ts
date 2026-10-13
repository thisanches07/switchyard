import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleBudgetStore } from "../../src/infra/db/budget-store.js";
import { createDatabase } from "../../src/infra/db/client.js";
import { DrizzleKeyStore } from "../../src/infra/db/key-store.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";
import { DrizzleUsageStore } from "../../src/infra/db/usage-store.js";
import { sampleEvent } from "../helpers/usage.js";

const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const KEY_A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const KEY_B1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe("budget store on Postgres (spec 007, AC-10/AC-12)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let budgets: DrizzleBudgetStore;
  let usage: DrizzleUsageStore;
  let keys: DrizzleKeyStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
    pool = createPostgresPool(container.getConnectionUri());
    const db = createDatabase(pool);
    await migrateDatabase(db);
    budgets = new DrizzleBudgetStore(db);
    usage = new DrizzleUsageStore(db);
    keys = new DrizzleKeyStore(db);

    await usage.insertEvents([
      // October 2026: known costs on two days, one unknown, team A has two keys.
      sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, costUsd: "0.0000140000" }),
      sampleEvent({
        teamId: TEAM_A,
        keyId: KEY_A1,
        costUsd: "1.5000000000",
        occurredAt: "2026-10-31T23:59:59.999Z",
      }),
      sampleEvent({ teamId: TEAM_A, keyId: KEY_A2, costUsd: "0.25" }),
      sampleEvent({ teamId: TEAM_A, keyId: KEY_A2, costUsd: null }),
      sampleEvent({ teamId: TEAM_B, keyId: KEY_B1, costUsd: "3" }),
      // Other months: excluded from October's spend.
      sampleEvent({
        teamId: TEAM_A,
        keyId: KEY_A1,
        costUsd: "100",
        occurredAt: "2026-09-30T23:59:59.999Z",
      }),
      sampleEvent({
        teamId: TEAM_A,
        keyId: KEY_A1,
        costUsd: "100",
        occurredAt: "2026-11-01T00:00:00.000Z",
      }),
    ]);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("sums known spend and counts unknown costs per key and per team for a period", async () => {
    const rows = await budgets.periodSpend("2026-10-01", "2026-11-01");
    const byRef = Object.fromEntries(
      rows.map((r) => [`${r.ref.scope}:${r.ref.id}`, [Number(r.spentUsd), r.unknownCostRequests]]),
    );
    expect(byRef).toEqual({
      [`key:${KEY_A1}`]: [1.500014, 0],
      [`key:${KEY_A2}`]: [0.25, 1],
      [`key:${KEY_B1}`]: [3, 0],
      [`team:${TEAM_A}`]: [1.750014, 1],
      [`team:${TEAM_B}`]: [3, 0],
    });
    // Exact decimals, never floats.
    expect(rows.find((r) => r.ref.id === TEAM_A)?.spentUsd).toBe("1.7500140000");
  });

  it("returns one scope's spend, zero when it has none", async () => {
    expect(
      await budgets.scopeSpend({ scope: "team", id: TEAM_A }, "2026-10-01", "2026-11-01"),
    ).toEqual({ spentUsd: "1.7500140000", unknownCostRequests: 1 });
    expect(
      await budgets.scopeSpend({ scope: "key", id: KEY_A1 }, "2026-11-01", "2026-12-01"),
    ).toEqual({ spentUsd: "100", unknownCostRequests: 0 });
    expect(
      await budgets.scopeSpend(
        { scope: "key", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        "2026-10-01",
        "2026-11-01",
      ),
    ).toEqual({ spentUsd: "0", unknownCostRequests: 0 });
  });

  it("lists the active keys and the teams that have a budget", async () => {
    const team = await keys.createTeam("budgeted", { monthlyBudgetUsd: "50" });
    await keys.createTeam("unbudgeted");
    const base = { teamId: team.id, allowedModels: null, expiresAt: null };
    const withBudget = await keys.createKey({
      ...base,
      name: "a",
      hash: "a".repeat(64),
      prefix: "sk-sy-a",
      monthlyBudgetUsd: "0",
    });
    const revoked = await keys.createKey({
      ...base,
      name: "b",
      hash: "b".repeat(64),
      prefix: "sk-sy-b",
      monthlyBudgetUsd: "5",
    });
    await keys.revokeKey(revoked.id);
    await keys.createKey({ ...base, name: "c", hash: "c".repeat(64), prefix: "sk-sy-c" });

    const listed = await budgets.listBudgets();
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        { ref: { scope: "key", id: withBudget.id }, limitUsd: "0.0000" },
        { ref: { scope: "team", id: team.id }, limitUsd: "50.0000" },
      ]),
    );
  });
});
