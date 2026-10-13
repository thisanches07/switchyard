/**
 * The attempt loop (spec 008): tries a request's candidates in strategy order with retries,
 * full-jitter backoff, circuit breakers and a request-wide time budget, until the first byte
 * (ADR-0008). One `switchyard.upstream` span per attempt.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Principal } from "../../core/auth.js";
import {
  GatewayError,
  internalError,
  noHealthyUpstream,
  upstreamTimeout,
} from "../../core/errors.js";
import type { CostEstimator, TokenCounts } from "../../core/pricing.js";
import type { ChatProvider } from "../../core/provider.js";
import type { CacheStatus } from "../../core/usage.js";
import { backoffDelay, type RetrySettings, retryAfterOf } from "../routing/backoff.js";
import type { BreakerPermit } from "../routing/breaker.js";
import { classifyFailure } from "../routing/classify.js";
import type { CandidateHealth, CandidateHealthRegistry } from "../routing/health.js";
import type { Candidate, RoutePlan } from "../routing/resolve.js";
import { orderCandidates } from "../routing/select.js";
import { type AttemptOutcome, countAttempt } from "../routing/telemetry.js";
import type { Timers } from "../routing/timers.js";
import {
  countUpstreamRequest,
  startUpstreamSpan,
  type UpstreamCallInfo,
  type UpstreamOutcome,
  type UpstreamSpan,
} from "./telemetry.js";

/** Long-lived routing state and sources of time and randomness (injected for tests). */
export interface RoutingDeps {
  health: CandidateHealthRegistry;
  timers: Timers;
  /** In [0, 1): backoff jitter. */
  random: () => number;
  /** Prices for `lowest-cost` (spec 007); without it every price is unknown. */
  costEstimator?: CostEstimator | undefined;
}

export interface AttemptSettings {
  retry: RetrySettings;
  /** `server.timeouts.totalMs`: the whole request, all attempts and waits (AC-7). */
  totalMs: number;
}

export interface RunAttemptsArgs<T> {
  /** Candidates the key may use (allowed-models filter already applied), in config order. */
  plan: Pick<RoutePlan, "strategy" | "candidates">;
  providers: ReadonlyMap<string, ChatProvider>;
  settings: AttemptSettings;
  deps: RoutingDeps;
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
  /** Token estimate of this request, for `lowest-cost` (spec 005 estimate). */
  estimate?: TokenCounts | undefined;
  telemetry: {
    logger: FastifyBaseLogger;
    operation?: "chat" | "embeddings";
    stream: boolean;
    principal?: Principal | undefined;
    /** Cache status of the request (spec 009), for requests_total. */
    cache?: CacheStatus | undefined;
  };
  /**
   * One attempt. For streams it opens the stream and reads the first chunk, so every failure
   * before the first byte is retried like a non-streaming one (AC-6).
   */
  call(provider: ChatProvider, candidate: Candidate, ctx: { signal: AbortSignal }): Promise<T>;
  /** Non-streaming: what the attempt span records on success. */
  describe?: ((value: T) => UpstreamOutcome) | undefined;
  /** Before the loop with `(undefined, 0)`, then before every attempt (headers, usage event). */
  report(candidate: Candidate | undefined, attempts: number): void;
}

/** The attempt that served the request. */
export interface Served<T> {
  value: T;
  candidate: Candidate;
  provider: ChatProvider;
  attempts: number;
  /** Ended for non-streams; still open for streams (the stream ends it). */
  upstream: UpstreamSpan;
  /** Streams: ended normally or the client left. Idempotent. */
  completed(): void;
  /** Streams: failed after the first chunk; counts against the breaker (ADR-0008). Idempotent. */
  midstreamFailed(): void;
}

interface Picked {
  candidate: Candidate;
  index: number;
  entry: CandidateHealth;
  permit: BreakerPermit;
}

/** First candidate from `next` (wrapping around) whose breaker admits a call now. */
function pick(order: Candidate[], next: number, deps: RoutingDeps): Picked | undefined {
  const now = deps.timers.now();
  for (let i = 0; i < order.length; i += 1) {
    const index = (next + i) % order.length;
    const candidate = order[index] as Candidate;
    const entry = deps.health.get(candidate.ref);
    const permit = entry.breaker.tryAcquire(now);
    if (permit) return { candidate, index, entry, permit };
  }
  return undefined;
}

/** Seconds until the earliest breaker becomes half-open (AC-9). */
function secondsUntilHalfOpen(order: Candidate[], deps: RoutingDeps): number {
  const now = deps.timers.now();
  const times = order.map((c) => deps.health.get(c.ref).breaker.halfOpenAt ?? now);
  return (Math.min(...times) - now) / 1_000;
}

/**
 * A plan's candidates in the order its strategy tries them now (spec 008, AC-2); also the order
 * in which the cache looks them up (spec 009, AC-3).
 */
export function orderForPlan(
  plan: Pick<RoutePlan, "strategy" | "candidates">,
  deps: Pick<RoutingDeps, "health" | "costEstimator">,
  estimate: TokenCounts | undefined,
): Candidate[] {
  const estimator = deps.costEstimator;
  return orderCandidates(plan.strategy, plan.candidates, {
    cost: estimator && estimate ? (c) => estimator.estimateUsd(c.ref, estimate) : undefined,
    latency: (c) => deps.health.peek(c.ref)?.ewma,
  });
}

const statusOf = (error: unknown) => String(error instanceof GatewayError ? error.status : 500);

export async function runAttempts<T>(args: RunAttemptsArgs<T>): Promise<Served<T>> {
  const { deps, settings } = args;
  const { timers } = deps;
  const order = orderForPlan(args.plan, deps, args.estimate);

  const deadline = timers.deadline(settings.totalMs);
  const signal = AbortSignal.any([args.signal, deadline.signal]);
  /** Candidates tried in this request → the Retry-After of their last failure. */
  const tried = new Map<string, number | undefined>();
  let attempts = 0;
  let next = 0;
  let lastError: unknown;
  /** The last failed attempt, counted in requests_total only if the request ends with it. */
  let uncounted: UpstreamCallInfo | undefined;

  const giveUp = (): never => {
    if (uncounted) countUpstreamRequest(uncounted, statusOf(lastError));
    throw lastError;
  };

  args.report(undefined, 0);
  try {
    while (attempts < settings.retry.maxAttempts) {
      if (args.signal.aborted) throw lastError ?? args.signal.reason;
      const picked = pick(order, next, deps);
      if (!picked) {
        if (attempts === 0) throw noHealthyUpstream(secondsUntilHalfOpen(order, deps));
        return giveUp();
      }
      const { candidate, index, entry, permit } = picked;

      let backoffMs = 0;
      if (tried.has(candidate.ref)) {
        backoffMs = backoffDelay(attempts, settings.retry, deps.random, tried.get(candidate.ref));
        if (backoffMs > deadline.remaining()) {
          permit.release();
          return giveUp();
        }
        try {
          await timers.sleep(backoffMs, signal);
        } catch {
          permit.release();
          if (args.signal.aborted) throw lastError;
          lastError = upstreamTimeout(candidate.provider);
          return giveUp();
        }
      }

      const provider = args.providers.get(candidate.provider);
      if (!provider) {
        permit.release();
        throw internalError();
      }
      attempts += 1;
      args.report(candidate, attempts);
      const info: UpstreamCallInfo = {
        provider,
        model: candidate.model,
        logger: args.telemetry.logger,
        stream: args.telemetry.stream,
        principal: args.telemetry.principal,
        attempt: { number: attempts, candidate: candidate.ref, backoffMs },
        ...(args.telemetry.operation && { operation: args.telemetry.operation }),
        ...(args.telemetry.cache && { cache: args.telemetry.cache }),
      };
      const upstream = startUpstreamSpan(info);
      const started = timers.now();
      uncounted = undefined;

      try {
        const value = await upstream.run(() => args.call(provider, candidate, { signal }));
        permit.succeed();
        entry.recordLatency(timers.now() - started);
        upstream.annotate({ "switchyard.attempt.outcome": "success" });
        if (!args.telemetry.stream) {
          entry.recordOutcome(true);
          countAttempt(candidate.ref, "success");
          upstream.succeed(args.describe?.(value) ?? {});
        }
        return served(value, candidate, provider, attempts, upstream, entry, deps);
      } catch (error) {
        lastError = error;
        if (args.signal.aborted) {
          // The client left: neither a success nor a failure of the candidate (AC-5, AC-8).
          permit.release();
          upstream.clientGone();
          throw error;
        }
        if (deadline.signal.aborted) {
          // The request-wide budget ran out during this attempt (AC-7).
          permit.fail(timers.now());
          entry.recordOutcome(false);
          lastError = upstreamTimeout(candidate.provider);
          finishFailed(upstream, candidate, "timeout", lastError, true);
          throw lastError;
        }
        const failure = classifyFailure(error);
        if (failure === "non_retryable") {
          permit.release();
          // A client error (4xx) says nothing about the candidate's health.
          entry.recordOutcome(error instanceof GatewayError && error.status < 500);
          finishFailed(upstream, candidate, "non_retryable_error", error, true);
          throw error;
        }
        permit.fail(timers.now());
        entry.recordOutcome(false);
        tried.set(candidate.ref, retryAfterOf(error, timers.now()));
        finishFailed(
          upstream,
          candidate,
          failure === "timeout" ? "timeout" : "retryable_error",
          error,
          false,
        );
        uncounted = info;
        next = index + 1;
      }
    }
    return giveUp();
  } finally {
    // Ends at the response (non-streams) or the first chunk (streams).
    deadline.clear();
  }
}

function finishFailed(
  upstream: UpstreamSpan,
  candidate: Candidate,
  outcome: AttemptOutcome,
  error: unknown,
  countRequest: boolean,
): void {
  countAttempt(candidate.ref, outcome);
  upstream.annotate({ "switchyard.attempt.outcome": outcome });
  upstream.fail(error, "before_first_byte", { countRequest });
}

function served<T>(
  value: T,
  candidate: Candidate,
  provider: ChatProvider,
  attempts: number,
  upstream: UpstreamSpan,
  entry: CandidateHealth,
  deps: RoutingDeps,
): Served<T> {
  let settled = false;
  const once = (fn: () => void) => () => {
    if (settled) return;
    settled = true;
    fn();
  };
  return {
    value,
    candidate,
    provider,
    attempts,
    upstream,
    completed: once(() => {
      entry.recordOutcome(true);
      countAttempt(candidate.ref, "success");
    }),
    midstreamFailed: once(() => {
      entry.breaker.recordFailure(deps.timers.now());
      entry.recordOutcome(false);
      countAttempt(candidate.ref, "midstream_error");
    }),
  };
}
