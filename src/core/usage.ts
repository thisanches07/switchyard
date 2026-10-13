/**
 * Usage events (spec 006): the `UsageEvent` v1 contract shared by the gateway, the usage worker
 * and later specs, plus the ports around it. Metadata only, never content (ADR-0010).
 */
import { z } from "zod";

const count = z.int().nonnegative();

export const USAGE_OPERATIONS = ["chat", "embeddings", "messages"] as const;
export const USAGE_OUTCOMES = [
  "success",
  "upstream_error",
  "upstream_error_midstream",
  "client_closed",
  "rejected",
] as const;
export const CACHE_STATUSES = ["miss", "hit", "semantic_hit", "bypass"] as const;

/**
 * `UsageEvent` v1 (topic `usage.events.v1`, docs/specs/waves.md). Strict: unknown fields are
 * rejected, so nothing (content in particular) can ride along without changing this schema.
 */
export const usageEventSchema = z.strictObject({
  id: z.uuidv7(),
  schemaVersion: z.literal(1),
  /** When the outcome was recorded (end of the request), UTC. */
  occurredAt: z.iso.datetime(),
  /** Same value as the `x-switchyard-request-id` response header. */
  requestId: z.string().min(1).max(200),
  teamId: z.uuid(),
  keyId: z.uuid(),
  operation: z.enum(USAGE_OPERATIONS),
  stream: z.boolean(),
  /** The `model` the client sent (alias or `provider/model`). */
  requestedModel: z.string().min(1).max(256),
  /** The provider and model actually called; null when no upstream call was made. */
  provider: z.string().min(1).nullable(),
  servedModel: z.string().min(1).nullable(),
  inputTokens: count,
  outputTokens: count,
  /** Provider-reported prompt-cache read tokens, included in `inputTokens` (not Switchyard's cache). */
  cachedInputTokens: count,
  /** True when any token count is an estimate (spec 003). */
  estimated: z.boolean(),
  /** Plain decimal string (no sign, no exponent); null = unknown, never "0" for unknown (spec 007). */
  costUsd: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "must be a plain decimal string")
    .nullable(),
  /** HTTP status returned to the client. */
  status: z.int().min(100).max(599),
  outcome: z.enum(USAGE_OUTCOMES),
  /** `code` of the OpenAI-shaped error sent to the client; null on success and client_closed. */
  errorCode: z.string().min(1).nullable(),
  latencyMs: count,
  /** Streams only: time to the first upstream chunk (`x-switchyard-ttfb-ms`). */
  ttfbMs: count.nullable(),
  /** Upstream attempts; 0 when no upstream call was made (spec 008). */
  attempts: count,
  cacheStatus: z.enum(CACHE_STATUSES),
  /** `{ type: count }` of PII found (spec 010). */
  piiDetections: z.record(z.string().min(1), count),
});

export type UsageEvent = z.infer<typeof usageEventSchema>;
export type UsageOperation = UsageEvent["operation"];
export type UsageOutcome = UsageEvent["outcome"];
export type CacheStatus = UsageEvent["cacheStatus"];

/**
 * Receives exactly one finished event per admitted request from the outcome hook (spec 006).
 * Called synchronously at the end of the request: must be fast and must not throw. Later specs
 * decorate it (cost, spec 007) or fan it out (budget counters).
 */
export interface OutcomeRecorder {
  record(event: UsageEvent): void;
}

/** A message for a Kafka topic. */
export interface OutboundMessage {
  key: string | null;
  value: string | Buffer;
  headers?: Record<string, string>;
}

/** Kafka producer port; `send` resolves once the broker acknowledged every message. */
export interface MessageProducer {
  send(topic: string, messages: OutboundMessage[]): Promise<void>;
  close(): Promise<void>;
}

/** Durable usage storage used by the worker (spec 006, AC-8..AC-10). */
export interface UsageStore {
  /**
   * In one transaction: inserts the events (existing ids are skipped) and adds only the inserted
   * ones to the daily aggregates. Runs a transaction even for an empty list, so an unavailable
   * database always throws.
   */
  insertEvents(events: readonly UsageEvent[]): Promise<{ inserted: number }>;
}

export const USAGE_GROUP_BY = ["team", "key", "model", "provider", "day"] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

/** `GET /admin/usage` filters: UTC dates (`YYYY-MM-DD`, inclusive). */
export interface UsageQuery {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  teamId?: string | undefined;
  keyId?: string | undefined;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of known costs only, as a decimal string ("0" when none is known). */
  costUsd: string;
  unknownCostRequests: number;
}

export interface UsageRow extends UsageTotals {
  /** Team id, key id, model reference, provider (null: no provider reached) or date. */
  group: string | null;
}

export interface UsageReport {
  data: UsageRow[];
  totals: UsageTotals;
}

/** Read side of the usage tables (spec 006, AC-11). */
export interface UsageReader {
  summarize(query: UsageQuery): Promise<UsageReport>;
}
