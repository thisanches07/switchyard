/**
 * The cache stage of a chat completion (spec 009): after admission and the PII stage, before any
 * provider. Looks up the exact cache, then the semantic cache; on a miss, hands the route a
 * `remember` (non-streaming) and a stream `tap` that store the finished response without delaying
 * it. A failing layer is skipped: caching may fail, requests may not (AC-12).
 */
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../../config/schema.js";
import type { Principal } from "../../core/auth.js";
import {
  type CachedResponse,
  cachedResponseSchema,
  type ExactCacheStore,
  type SemanticCacheStore,
} from "../../core/cache.js";
import type { ChatChunk, ChatRequest, Usage } from "../../core/chat.js";
import type { ChatProvider } from "../../core/provider.js";
import type { CacheStatus } from "../../core/usage.js";
import type { Candidate } from "../routing/resolve.js";
import type { Timers } from "../routing/timers.js";
import { assembleCompletion, cacheableBody } from "./chunks.js";
import { type CacheMode, exactEligible } from "./eligibility.js";
import { exactKey } from "./key.js";
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
