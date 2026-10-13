import { describe, expect, it } from "vitest";
import {
  GatewayError,
  upstreamClientError,
  upstreamError,
  upstreamRateLimited,
} from "../../../src/core/errors.js";
import type { ChatProvider, ChatResult } from "../../../src/core/provider.js";
import { createLogger } from "../../../src/infra/logger.js";
import { abortedCallError } from "../../../src/modules/providers/abort.js";
import { type RunAttemptsArgs, runAttempts } from "../../../src/modules/proxy/attempts.js";
import { CandidateHealthRegistry } from "../../../src/modules/routing/health.js";
import type { Candidate, RoutingStrategy } from "../../../src/modules/routing/resolve.js";
import { manualTimers } from "../../helpers/routing.js";

type Step = "ok" | GatewayError | "hang" | ((signal: AbortSignal) => Promise<ChatResult>);

const candidate = (ref: string): Candidate => {
  const slash = ref.indexOf("/");
  return { ref, provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
};

/** Providers whose successive calls follow a script; records the order of calls. */
function scripted(script: Record<string, Step[]>) {
  const calls: string[] = [];
  const providers = new Map<string, ChatProvider>();
  for (const name of Object.keys(script)) {
    const steps = script[name] ?? [];
    let i = 0;
    const provider: ChatProvider = {
      name,
      type: "mock",
      async chat(request, ctx) {
        calls.push(`${name}/${request.model}`);
        const step = steps[Math.min(i, steps.length - 1)] ?? "ok";
        i += 1;
        if (step === "ok")
          return { body: { ok: name }, usage: { inputTokens: 1, outputTokens: 1 } };
        if (step === "hang") {
          await new Promise((_, reject) =>
            ctx.signal.addEventListener("abort", () => reject(abortedCallError(name, ctx.signal))),
          );
        }
        if (typeof step === "function") return step(ctx.signal);
        throw step;
      },
      chatStream: () => Promise.reject(new Error("unused")),
      embeddings: () => Promise.reject(new Error("unused")),
    };
    providers.set(name, provider);
  }
  return { providers, calls };
}

interface SetupOptions {
  script: Record<string, Step[]>;
  candidates?: string[];
  strategy?: RoutingStrategy;
  maxAttempts?: number;
  totalMs?: number;
  random?: number;
  breaker?: { failureThreshold: number; openMs: number };
}

function setup(options: SetupOptions) {
  const timers = manualTimers();
  const { providers, calls } = scripted(options.script);
  const breaker = options.breaker ?? { failureThreshold: 5, openMs: 30_000 };
  const health = new CandidateHealthRegistry({
    settings: () => ({ circuitBreaker: breaker, routing: { ewmaAlpha: 0.5 } }),
    logger: { warn: () => {} } as never,
  });
  const reports: [string | undefined, number][] = [];
  const candidates = (options.candidates ?? Object.keys(options.script).map((p) => `${p}/m`)).map(
    candidate,
  );
  const run = (overrides: Partial<RunAttemptsArgs<ChatResult>> = {}) =>
    runAttempts<ChatResult>({
      plan: { strategy: options.strategy ?? "priority", candidates },
      providers,
      settings: {
        retry: { maxAttempts: options.maxAttempts ?? 3, baseDelayMs: 100, maxDelayMs: 2_000 },
        totalMs: options.totalMs ?? 120_000,
      },
      deps: { health, timers, random: () => options.random ?? 0.5 },
      signal: new AbortController().signal,
      telemetry: { logger: createLogger({ level: "silent" }), stream: false },
      call: (provider, c, ctx) => provider.chat({ model: c.model, messages: [] }, ctx),
      describe: (r) => r,
      report: (c, attempts) => reports.push([c?.ref, attempts]),
      ...overrides,
    });
  return { run, calls, reports, health, timers };
}

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected a GatewayError");
}

const e502 = () => upstreamError("x");

describe("runAttempts (spec 008)", () => {
  it("falls back to the next candidate without waiting (AC-3, AC-4)", async () => {
    const { run, calls, reports, timers } = setup({ script: { a: [e502()], b: ["ok"] } });
    const served = await run();
    expect(served.candidate.ref).toBe("b/m");
    expect(served.attempts).toBe(2);
    expect(served.value.body).toEqual({ ok: "b" });
    expect(calls).toEqual(["a/m", "b/m"]);
    expect(reports).toEqual([
      [undefined, 0],
      ["a/m", 1],
      ["b/m", 2],
    ]);
    expect(timers.sleeps).toEqual([]);
  });

  it("a single-candidate route retries the same candidate with full-jitter backoff", async () => {
    const { run, calls, timers } = setup({ script: { a: [e502(), e502(), "ok"] }, random: 0.5 });
    const served = await run();
    expect(served.attempts).toBe(3);
    expect(calls).toEqual(["a/m", "a/m", "a/m"]);
    // k = attempts so far: 0.5 × min(2000, 100 × 2^(k−1)).
    expect(timers.sleeps).toEqual([50, 100]);
  });

  it("wraps around the candidates and counts attempts across all of them (AC-3)", async () => {
    const { run, calls, timers } = setup({
      script: { a: [e502()], b: [e502()], c: [e502()] },
      maxAttempts: 5,
      random: 0.5,
    });
    const error = await failure(run());
    expect(error.code).toBe("upstream_error");
    expect(calls).toEqual(["a/m", "b/m", "c/m", "a/m", "b/m"]);
    // Only the repeats (attempts 4 and 5) wait: k = 3 and 4.
    expect(timers.sleeps).toEqual([200, 400]);
  });

  it("stops at maxAttempts and returns the last attempt's error (AC-5)", async () => {
    const last = upstreamClientError(429, { message: "slow down" });
    const { run, calls } = setup({ script: { a: [e502()], b: [last] }, maxAttempts: 2 });
    expect(await failure(run())).toBe(last);
    expect(calls).toHaveLength(2);
  });

  it("returns a non-retryable 4xx at once and leaves the breaker alone (AC-3, AC-8)", async () => {
    const bad = upstreamClientError(400, { message: "bad" });
    const { run, calls, health } = setup({ script: { a: [bad], b: ["ok"] } });
    expect(await failure(run())).toBe(bad);
    expect(calls).toEqual(["a/m"]);
    expect(health.get("a/m").breaker.consecutiveFailures).toBe(0);
  });

  it("honours an explicit retryable: false from the adapter", async () => {
    const auth = new GatewayError(
      502,
      "server_error",
      "upstream_auth_error",
      "m",
      {},
      {
        retryable: false,
      },
    );
    const { run, calls } = setup({ script: { a: [auth], b: ["ok"] } });
    expect(await failure(run())).toBe(auth);
    expect(calls).toEqual(["a/m"]);
  });

  it("waits at least Retry-After (capped) before retrying the same candidate (AC-4)", async () => {
    const limited = upstreamRateLimited("a", { "retry-after": "1" });
    const capped = upstreamRateLimited("a", { "retry-after": "60" });
    const { run, timers } = setup({ script: { a: [limited, capped, "ok"] }, random: 0 });
    await run();
    expect(timers.sleeps).toEqual([1_000, 2_000]);
  });

  it("stops when the client disconnects, without counting a breaker failure (AC-5)", async () => {
    const client = new AbortController();
    const { run, calls, health } = setup({
      script: {
        a: [
          async () => {
            client.abort();
            throw upstreamError("a");
          },
        ],
        b: ["ok"],
      },
    });
    await expect(run({ signal: client.signal })).rejects.toBeDefined();
    expect(calls).toEqual(["a/m"]);
    expect(health.get("a/m").breaker.consecutiveFailures).toBe(0);
  });

  it("answers 504 when the total budget runs out during an attempt (AC-7)", async () => {
    let timers: ReturnType<typeof manualTimers> | undefined;
    const ctx = setup({
      script: {
        a: [
          async (signal) => {
            timers?.advance(1_000);
            expect(signal.aborted).toBe(true);
            throw abortedCallError("a", signal);
          },
        ],
        b: ["ok"],
      },
      totalMs: 1_000,
    });
    timers = ctx.timers;
    const error = await failure(ctx.run());
    expect(error.status).toBe(504);
    expect(error.code).toBe("upstream_timeout");
    expect(ctx.calls).toEqual(["a/m"]);
    expect(ctx.health.get("a/m").breaker.consecutiveFailures).toBe(1);
  });

  it("stops with the last error when the next backoff exceeds the remaining budget (AC-7)", async () => {
    let timers: ReturnType<typeof manualTimers> | undefined;
    const ctx = setup({
      script: {
        a: [
          async () => {
            timers?.advance(100);
            throw upstreamError("a");
          },
        ],
      },
      totalMs: 150,
      random: 0.9,
    });
    timers = ctx.timers;
    const error = await failure(ctx.run());
    expect(error.code).toBe("upstream_error");
    expect(ctx.calls).toEqual(["a/m"]);
    expect(ctx.timers.sleeps).toEqual([]);
  });

  it("answers 503 no_healthy_upstream with retry-after when every breaker is open (AC-9)", async () => {
    const ctx = setup({
      script: { a: [e502()], b: [e502()] },
      breaker: { failureThreshold: 1, openMs: 5_000 },
      maxAttempts: 2,
    });
    await failure(ctx.run());
    ctx.timers.advance(1_500);
    ctx.reports.length = 0;
    ctx.calls.length = 0;
    const error = await failure(ctx.run());
    expect(error.status).toBe(503);
    expect(error.code).toBe("no_healthy_upstream");
    expect(error.headers["retry-after"]).toBe("4");
    expect(ctx.calls).toEqual([]);
    expect(ctx.reports).toEqual([[undefined, 0]]);
  });

  it("skips an open candidate and returns the last error once all are open (AC-8)", async () => {
    const ctx = setup({
      script: { a: [e502()], b: [e502(), "ok"] },
      breaker: { failureThreshold: 1, openMs: 5_000 },
      maxAttempts: 3,
    });
    const error = await failure(ctx.run());
    expect(error.code).toBe("upstream_error");
    expect(ctx.calls).toEqual(["a/m", "b/m"]);
  });

  it("admits a single half-open probe; concurrent requests skip it (AC-8)", async () => {
    let finishProbe: (() => void) | undefined;
    const ctx = setup({
      script: {
        a: [
          e502(),
          () =>
            new Promise<ChatResult>((resolve) => {
              finishProbe = () => resolve({ body: { probe: true } });
            }),
        ],
      },
      breaker: { failureThreshold: 1, openMs: 1_000 },
      maxAttempts: 1,
    });
    await failure(ctx.run());
    ctx.timers.advance(1_000);
    const probe = ctx.run();
    await Promise.resolve();
    const concurrent = await failure(ctx.run());
    expect(concurrent.code).toBe("no_healthy_upstream");
    expect(concurrent.headers["retry-after"]).toBe("1");
    finishProbe?.();
    expect((await probe).value.body).toEqual({ probe: true });
    expect(ctx.health.get("a/m").breaker.state(ctx.timers.now())).toBe("closed");
  });

  it("records an EWMA latency sample for successful attempts", async () => {
    let timers: ReturnType<typeof manualTimers> | undefined;
    const ctx = setup({
      script: {
        a: [
          async () => {
            timers?.advance(40);
            return { body: {} };
          },
        ],
      },
    });
    timers = ctx.timers;
    await ctx.run();
    expect(ctx.health.get("a/m").ewma).toBe(40);
  });

  it("orders by strategy: lowest-latency tries cold candidates, then the fastest (AC-2)", async () => {
    const ctx = setup({ script: { a: ["ok"], b: ["ok"] }, strategy: "lowest-latency" });
    ctx.health.get("a/m").recordLatency(500);
    await ctx.run();
    expect(ctx.calls).toEqual(["b/m"]);
    ctx.health.get("b/m").recordLatency(2_000);
    await ctx.run();
    expect(ctx.calls).toEqual(["b/m", "a/m"]);
  });

  it("orders lowest-cost with the cost estimator and the request estimate (AC-2)", async () => {
    const ctx = setup({ script: { a: ["ok"], b: ["ok"] }, strategy: "lowest-cost" });
    const seen: unknown[] = [];
    await ctx.run({
      estimate: { inputTokens: 10, outputTokens: 5 },
      deps: {
        health: ctx.health,
        timers: ctx.timers,
        random: () => 0,
        costEstimator: {
          estimateUsd: (ref, usage) => {
            seen.push([ref, usage]);
            return ref === "b/m" ? 0.001 : 0.01;
          },
        },
      },
    });
    expect(ctx.calls).toEqual(["b/m"]);
    expect(seen).toContainEqual(["a/m", { inputTokens: 10, outputTokens: 5 }]);
  });

  it("streams: success at the first chunk, then completion or mid-stream failure (AC-6, AC-8)", async () => {
    const ctx = setup({
      script: { a: ["ok"] },
      breaker: { failureThreshold: 2, openMs: 1_000 },
    });
    const first = await ctx.run({
      telemetry: { logger: createLogger({ level: "silent" }), stream: true },
    });
    first.midstreamFailed();
    first.midstreamFailed();
    const entry = ctx.health.get("a/m");
    expect(entry.breaker.consecutiveFailures).toBe(1);
    expect(entry.view(ctx.timers.now()).errorRate).toBe(1);
    const second = await ctx.run({
      telemetry: { logger: createLogger({ level: "silent" }), stream: true },
    });
    second.completed();
    expect(entry.breaker.consecutiveFailures).toBe(0);
    expect(entry.view(ctx.timers.now())).toMatchObject({ errorRate: 0.5, window: 2 });
  });
});
