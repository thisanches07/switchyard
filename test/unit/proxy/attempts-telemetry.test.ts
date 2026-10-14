import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upstreamClientError, upstreamError } from "../../../src/core/errors.js";
import type { ChatProvider, ChatResult } from "../../../src/core/provider.js";
import { createLogger } from "../../../src/infra/logger.js";
import { runAttempts } from "../../../src/modules/proxy/attempts.js";
import { CandidateHealthRegistry } from "../../../src/modules/routing/health.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { manualTimers } from "../../helpers/routing.js";
import { installInMemoryTracing, isUpstreamSpan } from "../../helpers/telemetry.js";

/** A provider failing with the given errors, then answering. */
function provider(name: string, failures: Error[]): ChatProvider {
  let calls = 0;
  return {
    name,
    type: "mock",
    async chat(): Promise<ChatResult> {
      const failure = failures[calls];
      calls += 1;
      if (failure) throw failure;
      return { body: {}, usage: { inputTokens: 3, outputTokens: 2 } };
    },
    chatStream: () => Promise.reject(new Error("unused")),
    embeddings: () => Promise.reject(new Error("unused")),
  };
}

describe("attempt telemetry (spec 008, AC-14)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let meters: ReturnType<typeof installTestMetrics>;

  beforeAll(() => {
    tracing = installInMemoryTracing();
    meters = installTestMetrics();
  });
  afterAll(async () => {
    await tracing.uninstall();
    await meters.uninstall();
  });
  beforeEach(() => {
    tracing.exporter.reset();
  });

  function run(providers: ChatProvider[], maxAttempts = 3) {
    const timers = manualTimers();
    const health = new CandidateHealthRegistry({
      settings: () => ({
        circuitBreaker: { failureThreshold: 5, openMs: 1_000 },
        routing: { ewmaAlpha: 0.3 },
      }),
      logger: { warn: () => {} } as never,
    });
    return runAttempts<ChatResult>({
      plan: {
        strategy: "priority",
        candidates: providers.map((p) => ({ ref: `${p.name}/m`, provider: p.name, model: "m" })),
      },
      providers: new Map(providers.map((p) => [p.name, p])),
      settings: { retry: { maxAttempts, baseDelayMs: 100, maxDelayMs: 1_000 }, totalMs: 60_000 },
      deps: { health, timers, random: () => 0.5 },
      signal: new AbortController().signal,
      telemetry: {
        logger: createLogger({ level: "silent" }),
        stream: false,
        principal: { teamId: "t-tel", keyId: "k" } as never,
      },
      call: (p, c, ctx) => p.chat({ model: c.model, messages: [] }, ctx),
      describe: (r) => r,
      report: () => {},
    });
  }

  const sum = async (name: string, match: Record<string, unknown>) =>
    (await meters.points(name))
      .filter((p) => Object.entries(match).every(([k, v]) => p.attributes[k] === v))
      .reduce((total, p) => total + Number(p.value), 0);

  it("records one span per attempt with candidate, attempt, outcome and backoff", async () => {
    await run([provider("tel-a", [upstreamError("tel-a"), upstreamError("tel-a")])], 3);
    const spans = tracing.exporter.getFinishedSpans().filter(isUpstreamSpan);
    expect(spans.map((s) => s.attributes)).toEqual([
      expect.objectContaining({
        "switchyard.candidate": "tel-a/m",
        "switchyard.attempt": 1,
        "switchyard.backoff_ms": 0,
        "switchyard.attempt.outcome": "retryable_error",
      }),
      expect.objectContaining({
        "switchyard.attempt": 2,
        "switchyard.backoff_ms": 50,
        "switchyard.attempt.outcome": "retryable_error",
      }),
      expect.objectContaining({
        "switchyard.attempt": 3,
        "switchyard.backoff_ms": 100,
        "switchyard.attempt.outcome": "success",
      }),
    ]);
  });

  it("counts every attempt by outcome and the client request once", async () => {
    await run([provider("tel-b", [upstreamError("tel-b")]), provider("tel-c", [])]);
    expect(await sum("switchyard_upstream_attempts_total", { candidate: "tel-b/m" })).toBe(1);
    expect(
      await sum("switchyard_upstream_attempts_total", {
        candidate: "tel-b/m",
        outcome: "retryable_error",
      }),
    ).toBe(1);
    expect(
      await sum("switchyard_upstream_attempts_total", {
        candidate: "tel-c/m",
        outcome: "success",
      }),
    ).toBe(1);
    expect(await sum("switchyard_requests_total", { team: "t-tel", provider: "tel-b" })).toBe(0);
    expect(
      await sum("switchyard_requests_total", { team: "t-tel", provider: "tel-c", status: "200" }),
    ).toBe(1);
  });

  it("a request that fails every attempt is counted once with the last status", async () => {
    await run([provider("tel-d", [upstreamError("d"), upstreamError("d")])], 2).catch(() => {});
    expect(await sum("switchyard_requests_total", { provider: "tel-d" })).toBe(1);
    expect(await sum("switchyard_requests_total", { provider: "tel-d", status: "502" })).toBe(1);
  });

  it("labels non-retryable failures", async () => {
    await run([provider("tel-e", [upstreamClientError(400, {})])]).catch(() => {});
    expect(
      await sum("switchyard_upstream_attempts_total", {
        candidate: "tel-e/m",
        outcome: "non_retryable_error",
      }),
    ).toBe(1);
    expect(await sum("switchyard_requests_total", { provider: "tel-e", status: "400" })).toBe(1);
  });
});
