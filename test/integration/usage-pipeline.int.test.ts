import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedpandaContainer } from "@testcontainers/redpanda";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UsageEvent, UsageStore } from "../../src/core/usage.js";
import { createDatabase, type Database } from "../../src/infra/db/client.js";
import { migrateDatabase } from "../../src/infra/db/migrate.js";
import { createPostgresPool } from "../../src/infra/db/postgres.js";
import { DrizzleUsageStore } from "../../src/infra/db/usage-store.js";
import { createKafka } from "../../src/infra/kafka/client.js";
import { createKafkaProducer } from "../../src/infra/kafka/producer.js";
import { createLogger } from "../../src/infra/logger.js";
import { createUsagePublisher } from "../../src/modules/usage/publisher.js";
import { startUsageWorker, type UsageWorker } from "../../src/usage-worker.js";
import { testApp } from "../helpers/app.js";
import { dockerPause, readTopic, startRedpanda } from "../helpers/kafka.js";
import { installTestMetrics } from "../helpers/metrics.js";
import { sampleEvent } from "../helpers/usage.js";

const logger = createLogger({ level: "silent" });

describe("usage pipeline: gateway producer → Redpanda → worker → Postgres (spec 006)", () => {
  let redpanda: StartedRedpandaContainer;
  let postgres: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: Database;
  let brokers: string;
  const workers: UsageWorker[] = [];

  beforeAll(async () => {
    [redpanda, postgres] = await Promise.all([
      startRedpanda(),
      new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start(),
    ]);
    brokers = redpanda.getBootstrapServers();
    pool = createPostgresPool(postgres.getConnectionUri());
    db = createDatabase(pool);
    await migrateDatabase(db);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  afterAll(async () => {
    await pool?.end();
    await Promise.all([redpanda?.stop(), postgres?.stop()]);
  });

  /** Unique topics per test so tests do not see each other's messages. */
  function topics() {
    const suffix = randomUUID().slice(0, 8);
    return { topic: `usage.events.${suffix}`, dlqTopic: `usage.dlq.${suffix}` };
  }

  async function worker(usage: { topic: string; dlqTopic: string }, store?: UsageStore) {
    const started = await startUsageWorker({
      brokers: [brokers],
      usage,
      db,
      logger,
      groupId: `group-${usage.topic}`,
      batchRetry: { initialMs: 100, maxMs: 500 },
      ...(store ? { store } : {}),
    });
    workers.push(started);
    return started;
  }

  function publisher(topic: string, bufferSize = 10_000) {
    const p = createUsagePublisher({
      config: { enabled: true, topic, bufferSize, flushIntervalMs: 20 },
      producer: createKafkaProducer({
        brokers: [brokers],
        clientId: "test-gateway",
        logger,
        messageTimeoutMs: 2_000,
      }),
      logger,
    });
    p.start();
    return p;
  }

  async function rawSend(topic: string, values: (string | UsageEvent)[]) {
    const producer = createKafkaProducer({ brokers: [brokers], clientId: "test-raw", logger });
    await producer.send(
      topic,
      values.map((v) => ({ key: null, value: typeof v === "string" ? v : JSON.stringify(v) })),
    );
    await producer.close();
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000) {
    const deadline = Date.now() + ms;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      value = await read();
    }
    return value;
  }

  const countRows = async (teamId: string) =>
    (await pool.query("SELECT count(*)::int AS n FROM usage_events WHERE team_id = $1", [teamId]))
      .rows[0].n as number;

  const dailyRequests = async (teamId: string) =>
    (
      await pool.query(
        "SELECT coalesce(sum(requests), 0)::int AS n FROM usage_daily WHERE team_id = $1",
        [teamId],
      )
    ).rows[0].n as number;

  it("creates the usage and DLQ topics at startup (AC-8)", async () => {
    const usage = topics();
    await worker(usage);
    const admin = createKafka({ brokers: [brokers], clientId: "test-admin", logger }).admin();
    await admin.connect();
    const existing = await admin.listTopics();
    await admin.disconnect();
    expect(existing).toEqual(expect.arrayContaining([usage.topic, usage.dlqTopic]));
  });

  it("stores a published event and its daily aggregate (AC-8, AC-13)", async () => {
    const usage = topics();
    await worker(usage);
    const teamId = randomUUID();
    const p = publisher(usage.topic);
    p.record(sampleEvent({ teamId, inputTokens: 11, outputTokens: 4 }));
    expect(
      await waitFor(
        () => countRows(teamId),
        (n) => n === 1,
      ),
    ).toBe(1);
    const { rows } = await pool.query(
      "SELECT requests::int, input_tokens::int, output_tokens::int FROM usage_daily WHERE team_id = $1",
      [teamId],
    );
    expect(rows).toEqual([{ requests: 1, input_tokens: 11, output_tokens: 4 }]);
    await p.close(Date.now() + 5_000);
  });

  it("stores the same event published twice once and counts it once (AC-9, AC-13)", async () => {
    const usage = topics();
    await worker(usage);
    const teamId = randomUUID();
    const event = sampleEvent({ teamId });
    const marker = sampleEvent({ teamId });
    await rawSend(usage.topic, [event, event, marker]);
    await waitFor(
      () => countRows(teamId),
      (n) => n >= 2,
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await countRows(teamId)).toBe(2);
    expect(await dailyRequests(teamId)).toBe(2);
  });

  it("sends a malformed message to the DLQ and stores the next valid one (AC-10, AC-13)", async () => {
    const usage = topics();
    await worker(usage);
    const teamId = randomUUID();
    await rawSend(usage.topic, ["{not json", sampleEvent({ teamId })]);
    expect(
      await waitFor(
        () => countRows(teamId),
        (n) => n === 1,
      ),
    ).toBe(1);
    const [dead] = await readTopic(brokers, usage.dlqTopic, 1);
    expect(dead?.value?.toString()).toBe("{not json");
    expect(dead?.headers).toMatchObject({
      "x-switchyard-dlq-reason": "invalid_json",
      "x-switchyard-source-topic": usage.topic,
    });
  });

  it("loses nothing and double-counts nothing across a worker restart (AC-9, AC-13)", async () => {
    const usage = topics();
    const teamId = randomUUID();
    const real = new DrizzleUsageStore(db);
    // First worker: commits to Postgres, then "crashes" before committing its Kafka offsets.
    let crashes = 0;
    const crashing: UsageStore = {
      async insertEvents(events) {
        const result = await real.insertEvents(events);
        if (crashes < 2 && events.length > 0) {
          crashes += 1;
          throw new Error("killed after the database commit");
        }
        return result;
      },
    };
    const first = await worker(usage, crashing);
    const events = Array.from({ length: 40 }, () => sampleEvent({ teamId }));
    await rawSend(usage.topic, events.slice(0, 20));
    await waitFor(
      () => countRows(teamId),
      (n) => n >= 5,
    );
    await first.stop();
    workers.splice(workers.indexOf(first), 1);

    await rawSend(usage.topic, events.slice(20));
    await worker(usage); // same consumer group: resumes from the committed offsets
    expect(
      await waitFor(
        () => countRows(teamId),
        (n) => n === 40,
      ),
    ).toBe(40);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await countRows(teamId)).toBe(40);
    expect(await dailyRequests(teamId)).toBe(40);
    expect(crashes).toBeGreaterThan(0);
  });

  it("buffers while the broker is down, counts drops and resumes without a restart (AC-6, AC-13)", async () => {
    const meters = installTestMetrics();
    try {
      const usage = topics();
      await worker(usage);
      const teamId = randomUUID();
      const p = publisher(usage.topic, 5);
      p.record(sampleEvent({ teamId }));
      expect(
        await waitFor(
          () => countRows(teamId),
          (n) => n === 1,
        ),
      ).toBe(1);

      dockerPause(redpanda.getId(), true);
      try {
        for (let i = 0; i < 12; i += 1) p.record(sampleEvent({ teamId }));
        expect(p.size()).toBe(5);
        await new Promise((r) => setTimeout(r, 3_000)); // sends time out and are retried
        expect(p.size()).toBe(5);
      } finally {
        dockerPause(redpanda.getId(), false);
      }
      const dropped = (await meters.points("switchyard_usage_events_dropped_total"))
        .filter((point) => point.attributes.reason === "buffer_full")
        .reduce((sum, point) => sum + (point.value as number), 0);
      expect(dropped).toBe(7);

      expect(
        await waitFor(
          () => countRows(teamId),
          (n) => n === 6,
          60_000,
        ),
      ).toBe(6);
      expect(p.size()).toBe(0);
      await p.close(Date.now() + 5_000);
    } finally {
      await meters.uninstall();
    }
  });

  it("never carries request content into Kafka or Postgres (AC-2)", async () => {
    const usage = topics();
    await worker(usage);
    const p = publisher(usage.topic);
    const { app, store } = await testApp({ usageRecorder: p });
    const marker = `marker-${randomUUID()}`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        user: marker,
        messages: [{ role: "user", content: `repeat after me: ${marker}` }],
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    const [key] = await store.listKeys();
    const teamId = key?.teamId as string;

    expect(
      await waitFor(
        () => countRows(teamId),
        (n) => n === 1,
      ),
    ).toBe(1);
    const [message] = await readTopic(brokers, usage.topic, 1);
    expect(message?.value?.toString()).toContain(teamId);
    expect(message?.value?.toString()).not.toContain(marker);
    const { rows } = await pool.query(
      "SELECT row_to_json(e)::text AS json FROM usage_events e WHERE team_id = $1",
      [teamId],
    );
    expect(rows[0]?.json).toContain(res.headers["x-switchyard-request-id"]);
    expect(rows[0]?.json).not.toContain(marker);
    await p.close(Date.now() + 5_000);
  });
});
