/**
 * Usage worker batch processing (spec 006, AC-8..AC-10, AC-12): validates each Kafka message,
 * stores the valid events idempotently and sets the invalid ones aside in the DLQ. The caller
 * commits offsets only after this resolves; if it throws, nothing was sent to the DLQ before the
 * database transaction succeeded, and the batch is redelivered.
 */
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import { formatPath } from "../../config/zod-issues.js";
import {
  type InboundMessage,
  type MessageProducer,
  type OutboundMessage,
  type UsageEvent,
  type UsageStore,
  usageEventSchema,
} from "../../core/usage.js";
import { usageMetrics } from "./telemetry.js";

export type { InboundMessage };

export interface BatchDeps {
  store: UsageStore;
  /** Producer for the DLQ topic. */
  producer: MessageProducer;
  dlqTopic: string;
  logger: FastifyBaseLogger;
}

export interface BatchResult {
  inserted: number;
  duplicate: number;
  dlq: number;
}

type Parsed = { ok: true; event: UsageEvent } | { ok: false; reason: string };

/** Parses one message; the reason names the problem, never the content (ADR-0010). */
export function parseMessage(value: Buffer | null): Parsed {
  if (value === null || value.length === 0) return { ok: false, reason: "empty" };
  let json: unknown;
  try {
    json = JSON.parse(value.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const result = usageEventSchema.safeParse(json);
  if (result.success) return { ok: true, event: result.data };
  const issue = result.error.issues[0];
  const path = issue ? formatPath(issue.path) || "(root)" : "(root)";
  return { ok: false, reason: `schema:${path}:${issue?.code ?? "invalid"}` };
}

export async function processBatch(
  messages: readonly InboundMessage[],
  deps: BatchDeps,
): Promise<BatchResult> {
  const span = trace.getTracer("switchyard").startSpan("switchyard.usage.consume", {
    attributes: {
      "messaging.system": "kafka",
      "messaging.destination.name": messages[0]?.topic ?? "",
      "messaging.batch.message_count": messages.length,
    },
  });
  try {
    const valid: UsageEvent[] = [];
    const rejected: OutboundMessage[] = [];
    for (const message of messages) {
      const parsed = parseMessage(message.value);
      if (parsed.ok) {
        valid.push(parsed.event);
        continue;
      }
      rejected.push({
        key: message.key ? message.key.toString("utf8") : null,
        value: message.value ?? Buffer.alloc(0),
        headers: {
          "x-switchyard-dlq-reason": parsed.reason,
          "x-switchyard-source-topic": message.topic,
          "x-switchyard-source-partition": String(message.partition),
          "x-switchyard-source-offset": message.offset,
        },
      });
      deps.logger.warn(
        { partition: message.partition, offset: message.offset, reason: parsed.reason },
        "invalid usage event sent to the DLQ",
      );
    }

    // 1. Database first (a transaction even when nothing is valid): if Postgres is down, nothing
    //    reaches the DLQ and no offset is committed (AC-10).
    const { inserted } = await deps.store.insertEvents(valid);
    // 2. Then the DLQ, with the original bytes.
    if (rejected.length > 0) await deps.producer.send(deps.dlqTopic, rejected);

    const result = { inserted, duplicate: valid.length - inserted, dlq: rejected.length };
    usageMetrics.worker("inserted", result.inserted);
    usageMetrics.worker("duplicate", result.duplicate);
    usageMetrics.worker("dlq", result.dlq);
    span.setAttributes({
      "switchyard.usage.inserted": result.inserted,
      "switchyard.usage.duplicate": result.duplicate,
      "switchyard.usage.dlq": result.dlq,
    });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.name : "error",
    });
    throw error;
  } finally {
    span.end();
  }
}
