/**
 * Usage publisher (spec 006, AC-4..AC-7): the gateway's `OutcomeRecorder`. Validates each event,
 * keeps it in a bounded in-memory buffer and publishes the buffer to Kafka in the background.
 * Requests never wait for Kafka; when the buffer is full, new events are dropped and counted
 * (ADR-0007).
 */
import type { FastifyBaseLogger } from "fastify";
import type { UsageConfig } from "../../config/schema.js";
import { formatPath } from "../../config/zod-issues.js";
import {
  type MessageProducer,
  type OutboundMessage,
  type OutcomeRecorder,
  type UsageEvent,
  usageEventSchema,
} from "../../core/usage.js";
import { usageMetrics } from "./telemetry.js";

export interface UsagePublisher extends OutcomeRecorder {
  /** Starts the periodic flush (every `flushIntervalMs`). */
  start(): void;
  /** Sends one batch now (no-op while another send is in flight). */
  flush(): Promise<void>;
  /**
   * Stops the timer and publishes what is buffered until `deadlineAt` (epoch ms, `Date.now()`
   * clock); whatever is left is counted as dropped (`shutdown`). Then closes the producer.
   */
  close(deadlineAt: number): Promise<void>;
  /** Events buffered, including the batch in flight. */
  size(): number;
}

export interface UsagePublisherDeps {
  config: Pick<UsageConfig, "enabled" | "topic" | "bufferSize" | "flushIntervalMs">;
  /** Required when `config.enabled`; never created otherwise (AC-3). */
  producer?: MessageProducer | undefined;
  logger: FastifyBaseLogger;
  /** Clock for the warning throttle (tests). */
  now?: () => number;
  /** Messages per send. */
  batchSize?: number;
}

const WARN_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to the promise's value, or to `timedOut` if it takes longer than `ms`. */
async function within<T, U>(promise: Promise<T>, ms: number, timedOut: U): Promise<T | U> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<U>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createUsagePublisher(deps: UsagePublisherDeps): UsagePublisher {
  const { config, logger } = deps;
  const producer = deps.producer;
  if (config.enabled && !producer) {
    throw new Error("usage publisher: a producer is required when usage is enabled");
  }
  const now = deps.now ?? Date.now;
  const batchSize = deps.batchSize ?? 500;

  let buffer: OutboundMessage[] = [];
  let inFlight: Promise<boolean> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const lastWarning = { full: Number.NEGATIVE_INFINITY, send: Number.NEGATIVE_INFINITY };
  const unwatch = usageMetrics.watchBuffer(() => buffer.length);

  function throttledWarn(kind: keyof typeof lastWarning, fields: object, msg: string) {
    if (now() - lastWarning[kind] < WARN_INTERVAL_MS) return;
    lastWarning[kind] = now();
    logger.warn(fields, msg);
  }

  /** Sends the oldest batch; resolves true when it was acknowledged. */
  function sendBatch(): Promise<boolean> {
    if (inFlight) return inFlight;
    if (!producer || buffer.length === 0) return Promise.resolve(true);
    const source = buffer;
    const batch = source.slice(0, batchSize);
    inFlight = producer
      .send(config.topic, batch)
      .then(() => {
        // Acknowledged: remove from the buffer (unless shutdown already gave up on it).
        if (source === buffer) buffer.splice(0, batch.length);
        usageMetrics.published(batch.length);
        return true;
      })
      .catch((error: unknown) => {
        throttledWarn(
          "send",
          { err: error instanceof Error ? error.message : String(error), buffered: buffer.length },
          "usage events not delivered, will retry",
        );
        return false;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return {
    record(event: UsageEvent) {
      const parsed = usageEventSchema.safeParse(event);
      if (!parsed.success) {
        usageMetrics.dropped("invalid");
        // Ids and field paths only: never values (ADR-0010).
        logger.warn(
          {
            eventId: typeof event?.id === "string" ? event.id : undefined,
            requestId: typeof event?.requestId === "string" ? event.requestId : undefined,
            issues: parsed.error.issues.map((issue) => formatPath(issue.path) || issue.code),
          },
          "invalid usage event dropped",
        );
        return;
      }
      if (!config.enabled) return;
      if (closed) {
        usageMetrics.dropped("shutdown");
        return;
      }
      if (buffer.length >= config.bufferSize) {
        usageMetrics.dropped("buffer_full");
        throttledWarn(
          "full",
          { bufferSize: config.bufferSize },
          "usage buffer full, dropping events",
        );
        return;
      }
      buffer.push({ key: parsed.data.teamId, value: JSON.stringify(parsed.data) });
    },

    start() {
      if (!config.enabled || timer || closed) return;
      timer = setInterval(() => void sendBatch(), config.flushIntervalMs);
      timer.unref();
    },

    async flush() {
      await sendBatch();
    },

    async close(deadlineAt) {
      closed = true;
      clearInterval(timer);
      timer = undefined;
      while (buffer.length > 0 && Date.now() < deadlineAt) {
        const delivered = await within(sendBatch(), deadlineAt - Date.now(), false);
        if (!delivered && Date.now() < deadlineAt) {
          await sleep(Math.min(RETRY_DELAY_MS, deadlineAt - Date.now()));
        }
      }
      if (buffer.length > 0) {
        usageMetrics.dropped("shutdown", buffer.length);
        logger.warn({ dropped: buffer.length }, "usage events dropped at shutdown");
        buffer = [];
      }
      unwatch();
      if (producer) await within(producer.close(), deadlineAt - Date.now(), undefined);
    },

    size: () => buffer.length,
  };
}
