import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  MessageProducer,
  OutboundMessage,
  UsageEvent,
  UsageStore,
} from "../../../src/core/usage.js";
import { createLogger } from "../../../src/infra/logger.js";
import { type InboundMessage, processBatch } from "../../../src/modules/usage/consume.js";
import { captureLogs } from "../../helpers/log-capture.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";
import { sampleEvent } from "../../helpers/usage.js";

/** In-memory UsageStore with the same idempotency as the Postgres one. */
function memoryStore() {
  const rows = new Map<string, UsageEvent>();
  const state = { down: false, calls: 0 };
  const store: UsageStore = {
    async insertEvents(events) {
      state.calls += 1;
      if (state.down) throw new Error("connect ECONNREFUSED");
      let inserted = 0;
      for (const event of events) {
        if (!rows.has(event.id)) {
          rows.set(event.id, event);
          inserted += 1;
        }
      }
      return { inserted };
    },
  };
  return { store, rows, state };
}

function recordingProducer() {
  const sent: { topic: string; messages: OutboundMessage[] }[] = [];
  const state = { down: false };
  const producer: MessageProducer = {
    async send(topic, messages) {
      if (state.down) throw new Error("broker down");
      sent.push({ topic, messages });
    },
    async close() {},
  };
  return { producer, sent, state };
}

let offset = 0;
const message = (value: string | null): InboundMessage => {
  offset += 1;
  return {
    topic: "usage.events.v1",
    partition: 2,
    offset: String(offset),
    key: Buffer.from("team"),
    value: value === null ? null : Buffer.from(value),
  };
};
const encode = (event: unknown) => JSON.stringify(event);

describe("usage worker batch processing (spec 006)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let meters: ReturnType<typeof installTestMetrics>;
  beforeAll(() => {
    tracing = installInMemoryTracing();
  });
  afterAll(async () => {
    await tracing.uninstall();
    await meters?.uninstall();
  });
  beforeEach(async () => {
    await meters?.uninstall();
    meters = installTestMetrics();
    tracing.exporter.reset();
  });

  function setup() {
    const db = memoryStore();
    const dlq = recordingProducer();
    const logs = captureLogs();
    const run = (messages: InboundMessage[]) =>
      processBatch(messages, {
        store: db.store,
        producer: dlq.producer,
        dlqTopic: "usage.events.dlq",
        logger: createLogger({ level: "info", destination: logs.stream }),
      });
    return { db, dlq, run, logs: logs.lines };
  }

  const workerCount = async (result: string) =>
    (await meters.points("switchyard_usage_worker_events_total"))
      .filter((p) => p.attributes.result === result)
      .reduce((sum, p) => sum + (p.value as number), 0);

  it("stores valid events and counts duplicates (AC-8, AC-9)", async () => {
    const { db, run } = setup();
    const a = sampleEvent();
    const b = sampleEvent();
    expect(await run([message(encode(a)), message(encode(b))])).toEqual({
      inserted: 2,
      duplicate: 0,
      dlq: 0,
    });
    expect(await run([message(encode(a))])).toEqual({ inserted: 0, duplicate: 1, dlq: 0 });
    expect([...db.rows.keys()]).toEqual([a.id, b.id]);
    expect(await workerCount("inserted")).toBe(2);
    expect(await workerCount("duplicate")).toBe(1);
  });

  it("de-duplicates the same id inside one batch", async () => {
    const { run } = setup();
    const a = sampleEvent();
    expect(await run([message(encode(a)), message(encode(a))])).toEqual({
      inserted: 1,
      duplicate: 1,
      dlq: 0,
    });
  });

  it("sends malformed messages to the DLQ with their original bytes and the reason (AC-10)", async () => {
    const { db, dlq, run, logs } = setup();
    const valid = sampleEvent();
    const notJson = message("{not json");
    const wrongSchema = message(encode({ ...sampleEvent(), schemaVersion: 2 }));
    const extraField = message(encode({ ...sampleEvent(), prompt: "do not leak" }));
    const empty = message(null);
    const result = await run([notJson, wrongSchema, message(encode(valid)), extraField, empty]);

    expect(result).toEqual({ inserted: 1, duplicate: 0, dlq: 4 });
    expect(db.rows.has(valid.id)).toBe(true);
    expect(dlq.sent).toHaveLength(1);
    expect(dlq.sent[0]?.topic).toBe("usage.events.dlq");
    const [first, second, third, fourth] = dlq.sent[0]?.messages ?? [];
    expect(first?.value).toEqual(Buffer.from("{not json"));
    expect(first?.key).toBe("team");
    expect(first?.headers).toEqual({
      "x-switchyard-dlq-reason": "invalid_json",
      "x-switchyard-source-topic": "usage.events.v1",
      "x-switchyard-source-partition": "2",
      "x-switchyard-source-offset": notJson.offset,
    });
    expect(second?.headers?.["x-switchyard-dlq-reason"]).toBe("schema:schemaVersion:invalid_value");
    expect(third?.headers?.["x-switchyard-dlq-reason"]).toBe("schema:(root):unrecognized_keys");
    expect(fourth?.headers?.["x-switchyard-dlq-reason"]).toBe("empty");
    expect(await workerCount("dlq")).toBe(4);
    expect(JSON.stringify(logs)).not.toContain("do not leak");
  });

  it("neither DLQs nor reports success while Postgres is down (AC-10)", async () => {
    const { db, dlq, run } = setup();
    db.state.down = true;
    await expect(run([message("{bad"), message(encode(sampleEvent()))])).rejects.toThrow(
      "ECONNREFUSED",
    );
    // An all-invalid batch still checks the database first.
    await expect(run([message("{bad")])).rejects.toThrow();
    expect(dlq.sent).toHaveLength(0);
    expect(await workerCount("dlq")).toBe(0);
  });

  it("fails the batch when the DLQ cannot be written", async () => {
    const { dlq, run } = setup();
    dlq.state.down = true;
    await expect(run([message("{bad")])).rejects.toThrow("broker down");
  });

  it("records one switchyard.usage.consume span per batch, without content (AC-12)", async () => {
    const { run } = setup();
    const event = sampleEvent({ requestedModel: "secret-model-name" });
    await run([message(encode(event)), message("{bad")]);
    const spans = tracing.exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["switchyard.usage.consume"]);
    expect(spans[0]?.attributes).toEqual({
      "messaging.system": "kafka",
      "messaging.destination.name": "usage.events.v1",
      "messaging.batch.message_count": 2,
      "switchyard.usage.inserted": 1,
      "switchyard.usage.duplicate": 0,
      "switchyard.usage.dlq": 1,
    });
  });

  it("marks the span as failed when the batch fails", async () => {
    const { db, run } = setup();
    db.state.down = true;
    await run([message(encode(sampleEvent()))]).catch(() => {});
    expect(tracing.exporter.getFinishedSpans()[0]?.status.code).toBe(2);
  });
});
