import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageProducer, OutboundMessage, UsageEvent } from "../../../src/core/usage.js";
import { createLogger } from "../../../src/infra/logger.js";
import { createUsagePublisher } from "../../../src/modules/usage/publisher.js";
import { captureLogs } from "../../helpers/log-capture.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { sampleEvent } from "../../helpers/usage.js";

const config = {
  enabled: true,
  topic: "usage.events.v1",
  dlqTopic: "usage.events.dlq",
  bufferSize: 3,
  flushIntervalMs: 10_000,
};

/** A producer whose sends can be made to fail or hang. */
function fakeProducer() {
  const sent: { topic: string; messages: OutboundMessage[] }[] = [];
  const state = {
    fail: false,
    hang: false,
    closed: false,
    pending: [] as (() => void)[],
  };
  const producer: MessageProducer = {
    async send(topic, messages) {
      if (state.hang) await new Promise<void>((resolve) => state.pending.push(resolve));
      if (state.fail) throw new Error("broker unreachable");
      sent.push({ topic, messages });
    },
    async close() {
      state.closed = true;
    },
  };
  const messages = () => sent.flatMap((s) => s.messages);
  return { producer, sent, state, messages };
}

describe("usage publisher (spec 006)", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    meters = installTestMetrics();
  });
  afterEach(async () => {
    await meters.uninstall();
  });

  function setup(overrides: Partial<typeof config> = {}, clock = { now: 0 }) {
    const fake = fakeProducer();
    const logs = captureLogs();
    const publisher = createUsagePublisher({
      config: { ...config, ...overrides },
      producer: fake.producer,
      logger: createLogger({ level: "info", destination: logs.stream }),
      now: () => clock.now,
    });
    return { ...fake, publisher, logs: logs.lines, clock };
  }

  const counter = async (name: string, attributes?: Record<string, string>) =>
    (await meters.points(name))
      .filter((p) => !attributes || JSON.stringify(p.attributes) === JSON.stringify(attributes))
      .reduce((sum, p) => sum + (p.value as number), 0);

  it("buffers synchronously and publishes keyed by team id on flush (AC-5)", async () => {
    const { publisher, sent, messages } = setup();
    const event = sampleEvent();
    publisher.record(event);
    expect(sent).toHaveLength(0); // nothing waits for Kafka
    expect(publisher.size()).toBe(1);

    await publisher.flush();
    expect(sent[0]?.topic).toBe("usage.events.v1");
    expect(messages()).toEqual([{ key: event.teamId, value: JSON.stringify(event) }]);
    expect(publisher.size()).toBe(0);
    expect(await counter("switchyard_usage_events_published_total")).toBe(1);
  });

  it("flushes on its own every flushIntervalMs", async () => {
    const { publisher, messages } = setup({ flushIntervalMs: 10 });
    publisher.start();
    publisher.record(sampleEvent());
    for (let i = 0; i < 100 && messages().length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(messages()).toHaveLength(1);
    await publisher.close(Date.now() + 1_000);
  });

  it("validates every event and drops invalid ones (AC-1)", async () => {
    const { publisher, logs } = setup();
    publisher.record({ ...sampleEvent(), inputTokens: -1 });
    publisher.record({ ...sampleEvent(), prompt: "secret" } as unknown as UsageEvent);
    expect(publisher.size()).toBe(0);
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "invalid" })).toBe(2);
    const warning = logs.find((l) => l.msg === "invalid usage event dropped");
    expect(warning).toMatchObject({ issues: ["inputTokens"] });
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("builds and validates but never publishes when usage is disabled (AC-3)", async () => {
    const logs = captureLogs();
    const publisher = createUsagePublisher({
      config: { ...config, enabled: false },
      logger: createLogger({ level: "info", destination: logs.stream }),
    });
    publisher.record(sampleEvent());
    publisher.record({ ...sampleEvent(), status: 1 });
    expect(publisher.size()).toBe(0);
    await publisher.flush();
    await publisher.close(Date.now() + 100);
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "invalid" })).toBe(1);
  });

  it("requires a producer when enabled", () => {
    expect(() =>
      createUsagePublisher({ config, logger: createLogger({ level: "silent" }) }),
    ).toThrow(/producer/);
  });

  it("keeps events after a failed send and delivers them once the broker is back (AC-6)", async () => {
    const { publisher, state, messages, logs } = setup();
    state.fail = true;
    publisher.record(sampleEvent());
    await publisher.flush();
    await publisher.flush();
    expect(publisher.size()).toBe(1);
    expect(logs.filter((l) => l.msg === "usage events not delivered, will retry")).toHaveLength(1);

    state.fail = false;
    await publisher.flush();
    expect(messages()).toHaveLength(1);
    expect(publisher.size()).toBe(0);
  });

  it("drops new events when the buffer is full, counts them and warns once a minute (AC-6)", async () => {
    const { publisher, state, logs, clock, messages } = setup();
    state.fail = true;
    for (let i = 0; i < 5; i += 1) publisher.record(sampleEvent());
    expect(publisher.size()).toBe(3);
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "buffer_full" })).toBe(
      2,
    );
    clock.now = 59_000;
    publisher.record(sampleEvent());
    clock.now = 61_000;
    publisher.record(sampleEvent());
    const warnings = logs.filter((l) => l.msg === "usage buffer full, dropping events");
    expect(warnings).toHaveLength(2);
    expect(await meters.points("switchyard_usage_buffer_events")).toContainEqual(
      expect.objectContaining({ value: 3 }),
    );

    state.fail = false;
    await publisher.flush();
    expect(messages()).toHaveLength(3);
    publisher.record(sampleEvent()); // room again
    expect(publisher.size()).toBe(1);
  });

  it("counts in-flight events against the buffer until the broker acknowledges them", async () => {
    const { publisher, state } = setup();
    state.hang = true;
    publisher.record(sampleEvent());
    publisher.record(sampleEvent());
    const flushing = publisher.flush();
    publisher.record(sampleEvent());
    publisher.record(sampleEvent()); // buffer (3) already holds 2 in flight + 1
    expect(publisher.size()).toBe(3);
    for (const resolve of state.pending.splice(0)) resolve();
    await flushing;
    expect(publisher.size()).toBe(1);
  });

  it("publishes the buffer on close and closes the producer (AC-7)", async () => {
    const { publisher, messages, state } = setup({ bufferSize: 2_000 });
    for (let i = 0; i < 1_200; i += 1) publisher.record(sampleEvent());
    await publisher.close(Date.now() + 5_000);
    expect(messages()).toHaveLength(1_200); // several batches
    expect(state.closed).toBe(true);
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "shutdown" })).toBe(0);
  });

  it("counts events still unpublished at the deadline as dropped on shutdown (AC-7)", async () => {
    const { publisher, state } = setup();
    state.hang = true;
    publisher.record(sampleEvent());
    publisher.record(sampleEvent());
    await publisher.close(Date.now() + 100);
    expect(publisher.size()).toBe(0);
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "shutdown" })).toBe(2);
    publisher.record(sampleEvent()); // after close
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "shutdown" })).toBe(3);
    for (const resolve of state.pending.splice(0)) resolve();
  });

  it("retries a failing broker until the shutdown deadline", async () => {
    const { publisher, state } = setup();
    state.fail = true;
    publisher.record(sampleEvent());
    const started = Date.now();
    await publisher.close(Date.now() + 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await counter("switchyard_usage_events_dropped_total", { reason: "shutdown" })).toBe(1);
  });
});
