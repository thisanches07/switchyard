import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../../../src/config/load.js";
import { CandidateHealthRegistry, ERROR_WINDOW } from "../../../src/modules/routing/health.js";
import { installTestMetrics } from "../../helpers/metrics.js";

const settings = {
  circuitBreaker: { failureThreshold: 2, openMs: 1_000 },
  routing: { ewmaAlpha: 0.5 },
};

function setup() {
  const warnings: { obj: unknown; msg: string }[] = [];
  const registry = new CandidateHealthRegistry({
    settings: () => settings,
    logger: { warn: ((obj: unknown, msg: string) => warnings.push({ obj, msg })) as never },
  });
  return { registry, warnings };
}

type Providers = Pick<LoadedConfig, "providers">;
const providers = (defs: Record<string, unknown>) => ({ providers: defs }) as unknown as Providers;

describe("CandidateHealthRegistry (spec 008)", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    meters = installTestMetrics();
  });
  afterEach(async () => {
    await meters.uninstall();
  });

  it("creates one entry per candidate and reuses it", () => {
    const { registry } = setup();
    expect(registry.peek("a/1")).toBeUndefined();
    const entry = registry.get("a/1");
    expect(registry.get("a/1")).toBe(entry);
    expect(entry.ewma).toBeUndefined();
  });

  it("computes EWMA latency with the configured alpha; the first sample seeds it", () => {
    const entry = setup().registry.get("a/1");
    entry.recordLatency(100);
    expect(entry.ewma).toBe(100);
    entry.recordLatency(200);
    expect(entry.ewma).toBe(150);
    entry.recordLatency(50);
    expect(entry.ewma).toBe(100);
    expect(entry.samples).toBe(3);
  });

  it("error rate covers the last 100 attempts only", () => {
    const entry = setup().registry.get("a/1");
    for (let i = 0; i < 50; i += 1) entry.recordOutcome(false);
    for (let i = 0; i < 100; i += 1) entry.recordOutcome(true);
    expect(entry.view(0)).toMatchObject({ errorRate: 0, window: ERROR_WINDOW });
    for (let i = 0; i < 25; i += 1) entry.recordOutcome(false);
    expect(entry.view(0).errorRate).toBe(0.25);
  });

  it("snapshot lists known candidates first, cold ones with defaults (AC-11)", () => {
    const { registry } = setup();
    const used = registry.get("z/9");
    used.recordLatency(42);
    used.recordOutcome(true);
    used.breaker.tryAcquire(0)?.fail(0);
    used.breaker.tryAcquire(0)?.fail(10);
    expect(registry.snapshot(20, ["a/1", "z/9"])).toEqual([
      {
        candidate: "a/1",
        state: "closed",
        consecutiveFailures: 0,
        halfOpenAt: null,
        latencyMs: { ewma: null, samples: 0 },
        errorRate: 0,
        window: 0,
      },
      {
        candidate: "z/9",
        state: "open",
        consecutiveFailures: 2,
        halfOpenAt: new Date(1_010).toISOString(),
        latencyMs: { ewma: 42, samples: 1 },
        errorRate: 0,
        window: 1,
      },
    ]);
    expect(registry.peek("a/1")).toBeUndefined();
  });

  it("logs each breaker transition once and exports the circuit state gauge (AC-14)", async () => {
    const { registry, warnings } = setup();
    const entry = registry.get("a/1");
    expect(await gauge(meters, "a/1")).toBe(0);
    entry.breaker.tryAcquire(0)?.fail(0);
    entry.breaker.tryAcquire(0)?.fail(0);
    expect(await gauge(meters, "a/1")).toBe(2);
    entry.breaker.state(1_000);
    entry.breaker.state(1_001);
    expect(await gauge(meters, "a/1")).toBe(1);
    expect(warnings.map((w) => w.obj)).toEqual([
      { candidate: "a/1", from: "closed", to: "open", consecutiveFailures: 2 },
      { candidate: "a/1", from: "open", to: "half-open", consecutiveFailures: 2 },
    ]);
    expect(warnings[0]?.msg).toBe("circuit breaker state changed");
  });

  it("retain keeps candidates whose provider definition is unchanged (AC-12)", () => {
    const { registry } = setup();
    for (const ref of ["a/1", "a/2", "b/1", "c/1"]) registry.get(ref).recordLatency(10);
    registry.retain(
      providers({ a: { type: "mock", latencyMs: 0 }, b: { type: "mock" }, c: { type: "mock" } }),
      providers({ a: { latencyMs: 0, type: "mock" }, b: { type: "mock", errorRate: 0.5 } }),
    );
    expect(registry.peek("a/1")?.ewma).toBe(10);
    expect(registry.peek("a/2")?.ewma).toBe(10);
    expect(registry.peek("b/1")).toBeUndefined();
    expect(registry.peek("c/1")).toBeUndefined();
  });
});

async function gauge(meters: ReturnType<typeof installTestMetrics>, candidate: string) {
  const points = await meters.points("switchyard_circuit_state");
  return points.find((p) => p.attributes.candidate === candidate)?.value;
}
