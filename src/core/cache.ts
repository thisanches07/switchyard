/**
 * Response cache ports (spec 009): the exact cache (Redis, ADR-0006) and the semantic cache
 * (pgvector, ADR-0009). Both store the same `CachedResponse`: the upstream response as it was
 * returned for the request sent upstream (PII placeholders kept, spec 010).
 */
import { z } from "zod";

/** Dimensions of every stored embedding (`vector(768)`, ADR-0005: nomic-embed-text). */
export const EMBEDDING_DIMENSIONS = 768;

const count = z.int().nonnegative();

/** A stored chat completion. Parsed with this schema whenever it is read back from a store. */
export const cachedResponseSchema = z.strictObject({
  v: z.literal(1),
  /** `provider/model` of the candidate that produced it. */
  candidate: z.string().min(3),
  /** The `chat.completion` body; served with a new `id` and `created`. */
  body: z.looseObject({ choices: z.array(z.unknown()).min(1) }),
  usage: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count.optional(),
  }),
  /** True when the usage was estimated (spec 003). */
  estimated: z.boolean(),
});

export type CachedResponse = z.infer<typeof cachedResponseSchema>;

/** Exact cache: opaque string values under fully built keys, with a TTL. */
export interface ExactCacheStore {
  /** Values of `keys`, in order (null = absent), in one round trip. */
  getMany(keys: readonly string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Where a semantic entry may be found (ADR-0009): team, candidate models, parameter shape. */
export interface SemanticScope {
  teamId: string;
  /** Candidate `provider/model` refs the request may be served by. */
  models: readonly string[];
  /** ADR-0019 hash of the request without its final user message. */
  paramsHash: string;
}

export interface SemanticMatch {
  id: string;
  model: string;
  /** Raw stored value; parse with `cachedResponseSchema`. */
  response: unknown;
  /** Cosine similarity in [-1, 1]. */
  similarity: number;
}

export interface NewSemanticEntry {
  teamId: string;
  model: string;
  paramsHash: string;
  embedding: readonly number[];
  response: CachedResponse;
  createdAt: Date;
  expiresAt: Date;
}

/** Semantic cache: nearest stored entry within a scope. */
export interface SemanticCacheStore {
  /** Nearest unexpired entry (`expires_at > now`) in scope, if any; the caller checks the threshold. */
  nearest(
    scope: SemanticScope,
    embedding: readonly number[],
    now: Date,
  ): Promise<SemanticMatch | undefined>;
  insert(entry: NewSemanticEntry): Promise<void>;
  /** Adds one to the entry's `hits`. */
  recordHit(id: string): Promise<void>;
  /** Deletes entries with `expires_at <= now`; returns how many. */
  deleteExpired(now: Date): Promise<number>;
}
