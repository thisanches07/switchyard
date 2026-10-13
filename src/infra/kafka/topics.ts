import { createKafka, type KafkaClientOptions } from "./client.js";

export interface TopicSpec {
  topic: string;
  numPartitions: number;
}

/** Creates the topics if they do not exist yet (idempotent; spec 006, AC-8). */
export async function ensureTopics(
  options: KafkaClientOptions,
  topics: TopicSpec[],
): Promise<void> {
  const admin = createKafka(options).admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics });
  } finally {
    await admin.disconnect();
  }
}
