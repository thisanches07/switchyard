/**
 * The cache stage of a chat completion (spec 009): after admission and the PII stage, before any
 * provider. Looks up the exact cache, then the semantic cache; on a miss, hands the route a
 * `remember` (non-streaming) and a stream `tap` that store the finished response without delaying
 * it. A failing layer is skipped: caching may fail, requests may not (AC-12).
 */
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config/schema.js";
import type { Principal } from "../../core/auth.js";
import {
  type CachedResponse,
  cachedResponseSchema,
  EMBEDDING_DIMENSIONS,
  type ExactCacheStore,
  type SemanticCacheStore,
  type SemanticScope,
} from "../../core/cache.js";
import type { ChatChunk, ChatRequest, Usage } from "../../core/chat.js";
import type { ChatProvider } from "../../core/provider.js";
import type { CacheStatus } from "../../core/usage.js";
import { type Candidate, splitModelRef } from "../routing/resolve.js";
import type { Timers } from "../routing/timers.js";
import { assembleCompletion, cacheableBody } from "./chunks.js";
import { type CacheMode, exactEligible, lastUserText, semanticEligible } from "./eligibility.js";
import { exactKey, paramsHash } from "./key.js";
import {
  type CacheLayer,
  countCacheError,
  countLookup,
  createWarnLimiter,
  type CacheStage as Stage,
} from "./telemetry.js";

export interface CacheStageDeps {
  exact?: ExactCacheStore | undefined;
  semantic?: SemanticCacheStore | undefined;
  /** Deadlines of semantic lookups and the warning limiter (spec 008 timers). */
  timers: Timers;
  /** Wall clock for `created` and `expires_at`; tests inject one. */
  clock: () => number;
}

export interface LookupArgs {
  config: AppConfig["cache"];
  /** Providers of the request's config snapshot (the semantic embedding call). */
  providers: ReadonlyMap<string, ChatProvider>;
  principal: Principal | undefined;
  /** Candidates the key may use, in the alias strategy's order (AC-3); computed only if needed. */
  candidates: () => readonly Candidate[];
  /** The request as sent upstream: after PII masking (AC-11). */
  request: ChatRequest;
  mode: CacheMode;
  logger: FastifyBaseLogger;
}

export interface CacheHit {
  status: "hit" | "semantic_hit";
  layer: CacheLayer;
  response: CachedResponse;
  /** Semantic hits only. */
  similarity?: number;
}

/** Feeds a streamed miss into the cache; `done` only on a clean end (ADR-0008). */
export interface StreamTap {
  chunk(chunk: ChatChunk): void;
  done(candidate: Candidate, usage: Usage, estimated: boolean): void;
}

export interface CacheLookup {
  status: CacheStatus;
  hit?: CacheHit;
  /** Stores a finished, successful miss. Never throws; never awaited by the response. */
  remember(candidate: Candidate, body: unknown, usage: Usage, estimated: boolean): void;
  /** Present when a miss would be stored. */
  tap?: StreamTap;
}

const NOTHING: Pick<CacheLookup, "remember"> = { remember: () => {} };

/** OpenAI embeddings body: the first vector is the one used (AC-5). */
const embeddingBody = z.looseObject({
  data: z.array(z.looseObject({ embedding: z.array(z.number()) })).min(1),
});

/** Settles with `work`, or rejects once `signal` aborts (the lookup budget ran out, AC-12). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(new Error("semantic cache lookup timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("semantic cache lookup timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createCacheStage(deps: CacheStageDeps) {
  const warn = createWarnLimiter(() => deps.timers.now());
  /** In-flight writes, so tests (and shutdown) can wait for them. */
  const pending = new Set<Promise<void>>();

  const failed = (logger: FastifyBaseLogger, layer: CacheLayer, stage: Stage, error: unknown) => {
    countCacheError(layer, stage);
    warn(logger, layer, stage, error);
  };

  function background(
    logger: FastifyBaseLogger,
    layer: CacheLayer,
    work: () => Promise<void>,
  ): void {
    const task = (async () => {
      try {
        await work();
      } catch (error) {
        failed(logger, layer, "write", error);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  /** First parseable entry among the candidates' keys, in strategy order; one round trip. */
  async function lookupExact(
    store: ExactCacheStore,
    args: LookupArgs,
    teamId: string,
  ): Promise<CacheHit | undefined> {
    const keys = args.candidates().map((c) => exactKey(teamId, c.ref, args.request));
    const values = await store.getMany(keys);
    for (const value of values) {
      if (value === null) continue;
      const parsed = cachedResponseSchema.safeParse(JSON.parse(value));
      if (!parsed.success) throw new Error("stored exact cache entry is not valid");
      return { status: "hit", layer: "exact", response: parsed.data };
    }
    return undefined;
  }

  /**
   * Embeds the final user message with `cache.semantic.embeddingModel` (AC-5): one call through
   * the configured provider, no retries, no admission, no budget; a `switchyard.cache.embed` span.
   */
  async function embed(args: LookupArgs, signal: AbortSignal): Promise<number[]> {
    const { embeddingModel } = args.config.semantic;
    const ref = splitModelRef(embeddingModel);
    const provider = ref && args.providers.get(ref.provider);
    if (!ref || !provider) throw new Error(`embedding provider of ${embeddingModel} not found`);
    const text = lastUserText(args.request) ?? "";
    const span = trace.getTracer("switchyard").startSpan("switchyard.cache.embed", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "embeddings",
        "gen_ai.system": ref.provider,
        "gen_ai.request.model": ref.model,
      },
    });
    const started = deps.timers.now();
    try {
      const result = await provider.embeddings({ model: ref.model, input: text }, { signal });
      const parsed = embeddingBody.safeParse(result.body);
      const vector = parsed.success ? parsed.data.data[0]?.embedding : undefined;
      if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`embedding is not ${EMBEDDING_DIMENSIONS}-dimensional`);
      }
      return vector;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "embedding_failed" });
      throw error;
    } finally {
      span.setAttribute("switchyard.cache.embedding_ms", Math.round(deps.timers.now() - started));
      span.end();
    }
  }

  async function lookup(args: LookupArgs): Promise<CacheLookup> {
    const { principal, config, logger } = args;
    if (!principal || args.mode === "bypass") return { status: "bypass", ...NOTHING };

    const exactStore = config.exact.enabled ? deps.exact : undefined;
    const useExact = exactStore !== undefined && exactEligible(args.request, args.mode);
    let looked = false;

    if (useExact) {
      looked = true;
      try {
        const hit = await lookupExact(exactStore, args, principal.teamId);
        countLookup("exact", hit ? "hit" : "miss");
        if (hit) return { status: "hit", hit, ...NOTHING };
      } catch (error) {
        countLookup("exact", "error");
        failed(logger, "exact", "lookup", error);
      }
    }

    const semanticStore = config.semantic.enabled ? deps.semantic : undefined;
    const useSemantic =
      semanticStore !== undefined &&
      principal.semanticCacheEnabled === true &&
      semanticEligible(args.request, config.semantic.maxTemperature, args.mode);
    /** The scope and embedding of this request, kept for the write after a miss (AC-6). */
    let semanticScope: SemanticScope | undefined;
    let embedding: number[] | undefined;

    if (useSemantic) {
      looked = true;
      semanticScope = {
        teamId: principal.teamId,
        models: args.candidates().map((c) => c.ref),
        paramsHash: paramsHash(args.request),
      };
      const scope = semanticScope;
      const deadline = deps.timers.deadline(config.semantic.lookupTimeoutMs);
      try {
        const match = await untilAborted(
          (async () => {
            embedding = await embed(args, deadline.signal);
            return semanticStore.nearest(scope, embedding, new Date(deps.clock()));
          })(),
          deadline.signal,
        );
        const hit = match && match.similarity >= config.semantic.similarityThreshold && match;
        if (hit) {
          const parsed = cachedResponseSchema.safeParse(hit.response);
          if (!parsed.success) throw new Error("stored semantic cache entry is not valid");
          countLookup("semantic", "hit");
          background(logger, "semantic", () => semanticStore.recordHit(hit.id));
          return {
            status: "semantic_hit",
            hit: {
              status: "semantic_hit",
              layer: "semantic",
              response: parsed.data,
              similarity: hit.similarity,
            },
            ...NOTHING,
          };
        }
        countLookup("semantic", "miss");
      } catch (error) {
        countLookup("semantic", "error");
        failed(logger, "semantic", "lookup", error);
      } finally {
        deadline.clear();
      }
    }

    if (!looked) return { status: "bypass", ...NOTHING };

    const remember = (candidate: Candidate, body: unknown, usage: Usage, estimated: boolean) => {
      if (!cacheableBody(body)) return;
      const entry: CachedResponse = {
        v: 1,
        candidate: candidate.ref,
        body,
        usage: {
          inputTokens: Math.max(0, Math.round(usage.inputTokens)),
          outputTokens: Math.max(0, Math.round(usage.outputTokens)),
          ...(usage.cachedInputTokens !== undefined && {
            cachedInputTokens: Math.max(0, Math.round(usage.cachedInputTokens)),
          }),
        },
        estimated,
      };
      if (useExact) {
        const key = exactKey(principal.teamId, candidate.ref, args.request);
        background(logger, "exact", () =>
          exactStore.set(key, JSON.stringify(entry), config.exact.ttlSeconds),
        );
      }
      // Only with the embedding computed during this request's lookup (AC-6).
      if (semanticStore && semanticScope && embedding) {
        const now = deps.clock();
        const insert = {
          teamId: semanticScope.teamId,
          model: candidate.ref,
          paramsHash: semanticScope.paramsHash,
          embedding,
          response: entry,
          createdAt: new Date(now),
          expiresAt: new Date(now + config.semantic.ttlSeconds * 1_000),
        };
        background(logger, "semantic", () => semanticStore.insert(insert));
      }
    };

    const chunks: ChatChunk[] = [];
    const tap: StreamTap = {
      chunk: (chunk) => {
        chunks.push(chunk);
      },
      done: (candidate, usage, estimated) => {
        const body = assembleCompletion(chunks);
        if (body) remember(candidate, body, usage, estimated);
      },
    };
    return { status: "miss", remember, tap };
  }

  return {
    lookup,
    /** Resolves once every write started so far has finished. */
    async settled(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

export type CacheStage = ReturnType<typeof createCacheStage>;
