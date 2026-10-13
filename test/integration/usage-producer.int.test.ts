import type { StartedRedpandaContainer } from "@testcontainers/redpanda";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKafkaProducer } from "../../src/infra/kafka/producer.js";
import { createLogger } from "../../src/infra/logger.js";
import { createUsagePublisher } from "../../src/modules/usage/publisher.js";
import { readTopic, startRedpanda } from "../helpers/kafka.js";
import { sampleEvent } from "../helpers/usage.js";

describe("usage producer on Redpanda (spec 006)", () => {
  let redpanda: StartedRedpandaContainer;

  beforeAll(async () => {
    redpanda = await startRedpanda();
  });

  afterAll(async () => {
    await redpanda?.stop();
  });

  it("publishes buffered events to the topic, keyed by team id (AC-5)", async () => {
    const logger = createLogger({ level: "silent" });
    const topic = "usage.events.producer-test";
    const publisher = createUsagePublisher({
      config: { enabled: true, topic, bufferSize: 100, flushIntervalMs: 50 },
      producer: createKafkaProducer({
        brokers: [redpanda.getBootstrapServers()],
        clientId: "test-gateway",
        logger,
      }),
      logger,
    });
    publisher.start();
    const events = [sampleEvent({ teamId: "11111111-1111-4111-8111-111111111111" }), sampleEvent()];
    for (const event of events) publisher.record(event);

    const messages = await readTopic(redpanda.getBootstrapServers(), topic, 2);
    await publisher.close(Date.now() + 5_000);

    expect(messages).toHaveLength(2);
    const byId = new Map(
      messages.map((m) => [JSON.parse(String(m.value)).id as string, m] as const),
    );
    for (const event of events) {
      const message = byId.get(event.id);
      expect(message?.key).toBe(event.teamId);
      expect(JSON.parse(String(message?.value))).toEqual(event);
    }
  });
});
