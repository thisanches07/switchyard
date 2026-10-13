import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { MessageProducer } from "../../core/usage.js";
import { createKafka, type KafkaClientOptions } from "./client.js";

export interface KafkaProducerOptions extends KafkaClientOptions {
  /**
   * How long librdkafka keeps trying to deliver a message before `send` rejects. Short, so a
   * broker outage surfaces to the usage buffer (which retries) instead of hiding in librdkafka.
   */
  messageTimeoutMs?: number;
}

/**
 * `MessageProducer` on Kafka (spec 006). Connects lazily on the first send, so the gateway starts
 * while the broker is down; a failed connection is retried on the next send.
 */
export function createKafkaProducer(options: KafkaProducerOptions): MessageProducer {
  const producer: KafkaJS.Producer = createKafka(options).producer({
    "linger.ms": 5,
    "message.timeout.ms": options.messageTimeoutMs ?? 10_000,
    kafkaJS: { acks: -1, allowAutoTopicCreation: true },
  });
  let connecting: Promise<void> | undefined;

  const connect = () => {
    connecting ??= producer.connect().catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  };

  return {
    async send(topic, messages) {
      if (messages.length === 0) return;
      await connect();
      await producer.send({
        topic,
        messages: messages.map((m) => ({
          key: m.key,
          value: m.value,
          ...(m.headers ? { headers: m.headers } : {}),
        })),
      });
    },
    async close() {
      if (!connecting) return;
      try {
        await connecting;
      } catch {
        return; // never connected
      }
      await producer.disconnect();
    },
  };
}
