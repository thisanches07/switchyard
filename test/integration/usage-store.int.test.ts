import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/infra/db/client.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";
import { DrizzleUsageStore } from "../../src/infra/db/usage-store.js";
import { sampleEvent } from "../helpers/usage.js";

const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const KEY_A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const KEY_B1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe("usage store on Postgres (spec 006)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: DrizzleUsageStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
    pool = createPostgresPool(container.getConnectionUri());
    const db = createDatabase(pool);
    await migrateDatabase(db);
    store = new DrizzleUsageStore(db);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE usage_events, usage_daily");
  });

  const daily = async () =>
    (
      await pool.query(
        `SELECT day::text, team_id, key_id, model, requests::int, input_tokens::int,
                output_tokens::int, cost_usd::text, unknown_cost_requests::int
           FROM usage_daily ORDER BY day, team_id, key_id, model`,
      )
    ).rows;

  it("stores every field of the event, with an exact cost (AC-8)", async () => {
    const event = sampleEvent({
      stream: true,
      cachedInputTokens: 4,
      estimated: true,
      costUsd: "0.0000123456789012345",
      errorCode: "upstream_error",
      outcome: "upstream_error_midstream",
      ttfbMs: 15,
      piiDetections: { email: 2 },
    });
    expect(await store.insertEvents([event])).toEqual({ inserted: 1 });
    const { rows } = await pool.query(
      `SELECT id, schema_version, to_char(occurred_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at, request_id, team_id, key_id,
              operation, stream, requested_model, provider, served_model, input_tokens,
              output_tokens, cached_input_tokens, estimated, cost_usd::text, status, outcome,
              error_code, latency_ms, ttfb_ms, attempts, cache_status, pii_detections
         FROM usage_events`,
    );
    expect(rows).toEqual([
      {
        id: event.id,
        schema_version: 1,
        occurred_at: event.occurredAt,
        request_id: event.requestId,
        team_id: event.teamId,
        key_id: event.keyId,
        operation: event.operation,
        stream: true,
        requested_model: event.requestedModel,
        provider: event.provider,
        served_model: event.servedModel,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        cached_input_tokens: 4,
        estimated: true,
        cost_usd: "0.0000123456789012345",
        status: event.status,
        outcome: "upstream_error_midstream",
        error_code: "upstream_error",
        latency_ms: event.latencyMs,
        ttfb_ms: 15,
        attempts: event.attempts,
        cache_status: event.cacheStatus,
        pii_detections: { email: 2 },
      },
    ]);
  });

  it("aggregates per UTC day, team, key and served model (AC-8)", async () => {
    await store.insertEvents([
      sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, inputTokens: 10, outputTokens: 1 }),
      sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, inputTokens: 5, outputTokens: 2 }),
      sampleEvent({
        teamId: TEAM_A,
        keyId: KEY_A1,
        occurredAt: "2026-10-13T23:59:59.999Z",
        inputTokens: 1,
        outputTokens: 1,
      }),
      sampleEvent({
        teamId: TEAM_A,
        keyId: KEY_A1,
        occurredAt: "2026-10-14T00:00:00.000Z",
        inputTokens: 1,
        outputTokens: 1,
      }),
      // No upstream call: grouped under the requested model.
      sampleEvent({
        teamId: TEAM_A,
        keyId: KEY_A2,
        provider: null,
        servedModel: null,
        requestedModel: "smart",
        outcome: "rejected",
        status: 400,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(await daily()).toEqual([
      {
        day: "2026-10-13",
        team_id: TEAM_A,
        key_id: KEY_A1,
        model: "mock/fast-model",
        requests: 3,
        input_tokens: 16,
        output_tokens: 4,
        cost_usd: "0",
        unknown_cost_requests: 3,
      },
      {
        day: "2026-10-13",
        team_id: TEAM_A,
        key_id: KEY_A2,
        model: "smart",
        requests: 1,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: "0",
        unknown_cost_requests: 1,
      },
      {
        day: "2026-10-14",
        team_id: TEAM_A,
        key_id: KEY_A1,
        model: "mock/fast-model",
        requests: 1,
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: "0",
        unknown_cost_requests: 1,
      },
    ]);
  });

  it("sums known costs only and counts unknown ones apart (AC-10)", async () => {
    await store.insertEvents([
      sampleEvent({ teamId: TEAM_B, keyId: KEY_B1, costUsd: "0.10" }),
      sampleEvent({ teamId: TEAM_B, keyId: KEY_B1, costUsd: "0.0000000001" }),
      sampleEvent({ teamId: TEAM_B, keyId: KEY_B1, costUsd: null }),
    ]);
    await store.insertEvents([sampleEvent({ teamId: TEAM_B, keyId: KEY_B1, costUsd: "1" })]);
    const [row] = await daily();
    expect(row).toMatchObject({ requests: 4, unknown_cost_requests: 1 });
    expect(Number(row?.cost_usd)).toBe(1.1000000001);
    expect(row?.cost_usd).toMatch(/^1\.10*1$/);
  });

  it("stores and counts a redelivered event exactly once (AC-9)", async () => {
    const event = sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, inputTokens: 7 });
    expect(await store.insertEvents([event])).toEqual({ inserted: 1 });
    expect(await store.insertEvents([event])).toEqual({ inserted: 0 });
    // Same id twice in one batch, next to a new event.
    const other = sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, inputTokens: 3 });
    expect(await store.insertEvents([event, other, other])).toEqual({ inserted: 1 });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usage_events");
    expect(rows[0].n).toBe(2);
    expect(await daily()).toEqual([expect.objectContaining({ requests: 2, input_tokens: 10 })]);
  });

  it("stores large batches", async () => {
    const events = Array.from({ length: 2_500 }, () =>
      sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, inputTokens: 1 }),
    );
    expect(await store.insertEvents(events)).toEqual({ inserted: 2_500 });
    expect(await daily()).toEqual([
      expect.objectContaining({ requests: 2_500, input_tokens: 2_500 }),
    ]);
  });

  it("throws when the database is unreachable, even for an empty batch (AC-10)", async () => {
    const deadPool = createPostgresPool("postgres://u:p@127.0.0.1:1/none");
    const dead = new DrizzleUsageStore(createDatabase(deadPool));
    await expect(dead.insertEvents([])).rejects.toThrow();
    await expect(dead.insertEvents([sampleEvent()])).rejects.toThrow();
    await deadPool.end();
  });

  describe("summarize (GET /admin/usage, AC-11)", () => {
    const at = (day: string) => `${day}T12:00:00.000Z`;
    beforeEach(async () => {
      await store.insertEvents([
        sampleEvent({
          teamId: TEAM_A,
          keyId: KEY_A1,
          occurredAt: at("2026-10-10"),
          costUsd: "0.25",
        }),
        sampleEvent({
          teamId: TEAM_A,
          keyId: KEY_A1,
          occurredAt: at("2026-10-10"),
          costUsd: "0.25",
        }),
        sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, occurredAt: at("2026-10-12"), costUsd: "1" }),
        sampleEvent({
          teamId: TEAM_A,
          keyId: KEY_A2,
          occurredAt: at("2026-10-12"),
          provider: "ollama",
          servedModel: "llama3.2",
          inputTokens: 100,
        }),
        sampleEvent({ teamId: TEAM_B, keyId: KEY_B1, occurredAt: at("2026-10-11"), costUsd: "2" }),
        sampleEvent({
          teamId: TEAM_B,
          keyId: KEY_B1,
          occurredAt: at("2026-10-11"),
          provider: null,
          servedModel: null,
          requestedModel: "mock/x",
          outcome: "rejected",
          status: 400,
          attempts: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
        // Outside the range.
        sampleEvent({ teamId: TEAM_A, keyId: KEY_A1, occurredAt: at("2026-09-01"), costUsd: "9" }),
      ]);
    });

    const range = { from: "2026-10-10", to: "2026-10-12" };
    const groups = async (groupBy: "team" | "key" | "model" | "provider" | "day") =>
      (await store.summarize({ ...range, groupBy })).data.map((r) => [
        r.group,
        r.requests,
        Number(r.costUsd),
      ]);

    it("groups by day in date order", async () => {
      expect(await groups("day")).toEqual([
        ["2026-10-10", 2, 0.5],
        ["2026-10-11", 2, 2],
        ["2026-10-12", 2, 1],
      ]);
    });

    it("groups by team and key, highest cost first", async () => {
      expect(await groups("team")).toEqual([
        [TEAM_B, 2, 2],
        [TEAM_A, 4, 1.5],
      ]);
      expect(await groups("key")).toEqual([
        [KEY_B1, 2, 2],
        [KEY_A1, 3, 1.5],
        [KEY_A2, 1, 0],
      ]);
    });

    it("groups by model reference and by provider (null: no provider reached)", async () => {
      expect(await groups("model")).toEqual([
        ["mock/fast-model", 4, 3.5],
        ["mock/x", 1, 0],
        ["ollama/llama3.2", 1, 0],
      ]);
      expect(await groups("provider")).toEqual([
        ["mock", 4, 3.5],
        ["ollama", 1, 0],
        [null, 1, 0],
      ]);
    });

    it("reports token sums, unknown costs and totals, with filters", async () => {
      const report = await store.summarize({ ...range, groupBy: "key", teamId: TEAM_A });
      expect(report.data.map((r) => r.group)).toEqual([KEY_A1, KEY_A2]);
      expect(report.data[1]).toMatchObject({ inputTokens: 100, unknownCostRequests: 1 });
      expect(report.totals).toMatchObject({
        requests: 4,
        inputTokens: 136,
        outputTokens: 24,
        unknownCostRequests: 1,
      });
      expect(Number(report.totals.costUsd)).toBe(1.5);

      const byKey = await store.summarize({ ...range, groupBy: "provider", keyId: KEY_B1 });
      expect(byKey.totals).toMatchObject({ requests: 2, unknownCostRequests: 1 });
    });

    it("returns zero totals for an empty range", async () => {
      const report = await store.summarize({
        from: "2020-01-01",
        to: "2020-01-02",
        groupBy: "day",
      });
      expect(report).toEqual({
        data: [],
        totals: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: "0",
          unknownCostRequests: 0,
        },
      });
    });
  });
});
