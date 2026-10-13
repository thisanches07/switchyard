import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { testApp } from "../helpers/app.js";
import { testConfig } from "../helpers/config.js";
import { fakeHttp, jsonResponse } from "../helpers/http.js";
import { manualTimers, seededRandom } from "../helpers/routing.js";

/**
 * Chaos test (spec 008, AC-15): three mock candidates failing 30 % of their calls before
 * answering, retry.maxAttempts 5, a fixed seed for failures and backoff jitter, and a manual
 * clock (backoff waits advance it at once). Deterministic: no wall-clock tolerances.
 */
const N = 1_000;
const SEED = 20261013;

interface Outcome {
  status: number;
  attempts: string | undefined;
  provider: string | undefined;
  /** Streams: completion ids seen in the body (must be exactly one). */
  ids: number;
  done: boolean;
}

async function runChaos(seed: number): Promise<Outcome[]> {
  const config = testConfig({
    providers: {
      c1: { type: "mock", errorRate: 0.3 },
      c2: { type: "mock", errorRate: 0.3 },
      c3: { type: "mock", errorRate: 0.3 },
    },
    aliases: { chaos: { strategy: "priority", candidates: ["c1/m", "c2/m", "c3/m"] } },
    retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 2_000 },
    // Random 30 % noise must not trip breakers for long: with the default threshold (5) every
    // candidate opens at some point in 1000+ calls and requests then get no_healthy_upstream.
    circuitBreaker: { failureThreshold: 10, openMs: 1_000 },
  });
  const timers = manualTimers();
  const providers = createProviderRegistry(
    config,
    {},
    { http: fakeHttp(() => jsonResponse(500, {})).client, random: seededRandom(seed) },
  );
  const { app } = await testApp({
    config,
    providers,
    level: "silent",
    routing: { timers, random: seededRandom(seed + 1) },
  });

  const outcomes: Outcome[] = [];
  try {
    for (let i = 0; i < N; i += 1) {
      const stream = i % 2 === 1;
      timers.advance(50); // requests arrive 50 ms apart on the manual clock
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "chaos", stream, messages: [{ role: "user", content: `request ${i}` }] },
      });
      const ids = stream
        ? new Set(
            res.body
              .split("\n\n")
              .filter((b) => b.startsWith("data: {"))
              .map((b) => (JSON.parse(b.slice(6)) as { id?: string }).id),
          ).size
        : 1;
      outcomes.push({
        status: res.statusCode,
        attempts: res.headers["x-switchyard-attempts"] as string | undefined,
        provider: res.headers["x-switchyard-provider"] as string | undefined,
        ids,
        done: !stream || res.body.trimEnd().endsWith("data: [DONE]"),
      });
    }
  } finally {
    await app.close();
  }
  return outcomes;
}

describe("routing chaos (spec 008, AC-15)", () => {
  it("1000 requests over three 30 %-failing candidates: ≥ 990 succeed, deterministically", async () => {
    const first = await runChaos(SEED);
    const succeeded = first.filter((o) => o.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(990);

    // No stream mixes content from more than one attempt (ADR-0008).
    for (const outcome of succeeded) {
      expect(outcome.ids).toBe(1);
      expect(outcome.done).toBe(true);
    }
    // Retries really happened.
    expect(first.some((o) => Number(o.attempts) > 1)).toBe(true);
    expect(new Set(succeeded.map((o) => o.provider)).size).toBeGreaterThan(1);

    // Same seed, same results.
    expect(await runChaos(SEED)).toEqual(first);
  });
});
