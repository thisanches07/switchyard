import { type Counter, type MeterProvider, metrics, trace } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import type { Principal } from "../../core/auth.js";
import { rateLimited, rateLimiterUnavailable, requestTooLargeForLimit } from "../../core/errors.js";
import type { RateLimiter, TakeResult } from "../../core/ratelimit.js";
import { rateLimitHeaders, retryAfterSeconds } from "./headers.js";
import { buildPlan, type DefaultLimits, type PlannedBucket } from "./plan.js";

export interface AdmissionConfig {
  defaults: DefaultLimits;
  onRedisError: "open" | "closed";
}

export interface Admission {
  /** x-ratelimit-* headers for the response; empty when nothing is limited or on fail-open. */
  headers: Record<string, string>;
  reservedTokens: number;
  /**
   * Settles the token reservation against real usage (spec 005, AC-6): refunds the unused part
   * or charges the excess. `undefined` refunds everything (the call produced no tokens).
   * Never throws.
   */
  reconcile(actualTokens: number | undefined): Promise<void>;
}

export interface AdmissionDeps {
  limiter: RateLimiter;
  /** A getter reads reloaded limits per request (spec 008 hot reload). */
  config: AdmissionConfig | (() => AdmissionConfig);
  logger: FastifyBaseLogger;
  now?: () => number;
}

let instruments: { provider: MeterProvider; rejections: Counter; failOpen: Counter } | undefined;
function counters() {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    instruments = {
      provider,
      rejections: meter.createCounter("switchyard_ratelimit_rejections_total", {
        description: "Requests rejected by a rate limit, by scope and kind",
      }),
      failOpen: meter.createCounter("switchyard_ratelimit_fail_open_total", {
        description: "Requests admitted without rate limiting because the limiter was unavailable",
      }),
    };
  }
  return instruments;
}

/** Counts a rejection by scope and kind (also used by the auth-failure limit). */
export function countRejection(scope: string, kind: string): void {
  counters().rejections.add(1, { scope, kind });
}

const NO_LIMITS: Admission = { headers: {}, reservedTokens: 0, reconcile: async () => {} };
const WARN_INTERVAL_MS = 60_000;

/** Rate-limit admission for `/v1` requests (spec 005). */
export function createAdmission(deps: AdmissionDeps) {
  const now = deps.now ?? Date.now;
  const source = deps.config;
  const config = typeof source === "function" ? source : () => source;
  let lastWarning = Number.NEGATIVE_INFINITY;

  function limiterFailed(error: unknown): Admission {
    if (config().onRedisError === "closed") throw rateLimiterUnavailable();
    counters().failOpen.add(1);
    if (now() - lastWarning >= WARN_INTERVAL_MS) {
      lastWarning = now();
      deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "rate limiter unavailable, admitting requests",
      );
    }
    return NO_LIMITS;
  }

  function headersFor(plan: PlannedBucket[], result: TakeResult) {
    return rateLimitHeaders(
      plan.map((bucket, i) => ({
        kind: bucket.kind,
        capacity: bucket.capacity,
        remaining: result.buckets[i]?.remaining ?? bucket.capacity,
        resetMs: result.buckets[i]?.resetMs ?? 0,
      })),
    );
  }

  return {
    async admit(principal: Principal, estimate: number): Promise<Admission> {
      const plan = buildPlan(principal, config().defaults, estimate);
      if (plan.oversized) {
        throw requestTooLargeForLimit(plan.oversized.scope, plan.oversized.capacity);
      }
      if (plan.buckets.length === 0) return NO_LIMITS;

      let result: TakeResult;
      try {
        result = await deps.limiter.take(plan.buckets);
      } catch (error) {
        return limiterFailed(error);
      }

      const headers = headersFor(plan.buckets, result);
      const span = trace.getActiveSpan();

      if (!result.allowed) {
        // Report the first bucket that could not cover its cost.
        const index = plan.buckets.findIndex(
          (b, i) => (result.buckets[i]?.remaining ?? 0) < b.cost,
        );
        const blocking = plan.buckets[Math.max(0, index)] as PlannedBucket;
        countRejection(blocking.scope, blocking.kind);
        span?.setAttributes({
          "switchyard.ratelimit.scope": blocking.scope,
          "switchyard.ratelimit.kind": blocking.kind,
        });
        throw rateLimited(blocking.kind, blocking.scope, blocking.capacity, {
          ...headers,
          "retry-after": String(retryAfterSeconds(result.retryAfterMs)),
        });
      }

      const tokenBuckets = plan.buckets.filter((b) => b.kind === "tokens");
      span?.setAttribute("switchyard.ratelimit.reserved_tokens", estimate);
      return {
        headers,
        reservedTokens: estimate,
        async reconcile(actual) {
          if (tokenBuckets.length === 0) return;
          const delta = actual === undefined ? estimate : estimate - actual;
          if (actual !== undefined)
            span?.setAttribute("switchyard.ratelimit.actual_tokens", actual);
          try {
            await deps.limiter.adjust(
              tokenBuckets.map((b) => ({ key: b.key, capacity: b.capacity, delta })),
            );
          } catch (error) {
            // Never fail a response that already succeeded; the bucket self-heals by refilling.
            deps.logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "rate limit reconciliation failed",
            );
          }
        },
      };
    },
  };
}

export type AdmissionService = ReturnType<typeof createAdmission>;
