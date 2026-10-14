// FIXTURE numbers only (see test/helpers/bench.ts): these test the arithmetic, not the gateway.
import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  evaluateRun,
  evaluateScenario,
  percentileDifference,
} from "../../../bench/lib/evaluate.ts";
import {
  extractSummary,
  SUMMARY_BEGIN,
  SUMMARY_END,
  trend,
} from "../../../bench/lib/k6-summary.ts";
import { makeRun, makeSummary } from "../../helpers/bench.ts";

const passing = {
  "no-cache.direct": { latency: [50, 60, 70] as [number, number, number], requests: 6000 },
  "no-cache.gateway": { latency: [53, 66, 90] as [number, number, number], requests: 6000 },
  "chaos.gateway": {
    latency: [55, 70, 300] as [number, number, number],
    requests: 2400,
    ok: 2398,
    failed: 2,
  },
};

describe("k6 summary extraction", () => {
  it("reads the JSON between the markers, ignoring other output", () => {
    const summary = makeSummary({ latency: [1, 2, 3] });
    const stdout = `banner\n${SUMMARY_BEGIN}\n${JSON.stringify(summary)}\n${SUMMARY_END}\n`;
    expect(trend(extractSummary(stdout), "bench_latency")).toEqual({
      p50: 1,
      p95: 2,
      p99: 3,
      count: 1000,
    });
  });

  it("fails without markers or metrics", () => {
    expect(() => extractSummary("no summary")).toThrow(/no benchmark summary/);
    expect(() => extractSummary(`${SUMMARY_BEGIN}{}${SUMMARY_END}`)).toThrow(/no metrics/);
  });
});

describe("statistics and overhead (AC-7)", () => {
  it("computes percentiles, achieved rate and client overhead as a difference of percentiles", () => {
    const result = evaluateScenario(makeRun({ id: "fixture-a", summaries: passing }), "no-cache");
    expect(result.gateway?.latency).toMatchObject({ p50: 53, p95: 66, p99: 90 });
    expect(result.direct?.latency).toMatchObject({ p50: 50, p95: 60, p99: 70 });
    // 6000 steady requests over the configured 120 s steady phase.
    expect(result.gateway?.achievedRate).toBe(50);
    expect(result.clientOverhead).toEqual({ p50: 3, p95: 6, p99: 20 });
  });

  it("has no overhead without a baseline", () => {
    expect(percentileDifference({ p50: 1, p95: 2, p99: 3 }, null)).toBeNull();
  });

  it("reports the streaming TTFB overhead", () => {
    const run = makeRun({
      id: "fixture-s",
      summaries: {
        "streaming.direct": { latency: [200, 210, 220], ttfb: [50, 52, 55] },
        "streaming.gateway": { latency: [205, 218, 240], ttfb: [53, 58, 70] },
      },
    });
    expect(evaluateScenario(run, "streaming").clientTtfbOverhead).toEqual({
      p50: 3,
      p95: 6,
      p99: 15,
    });
  });

  it("flags dropped iterations and a client/server disagreement", () => {
    const run = makeRun({
      id: "fixture-d",
      summaries: { ...passing, "no-cache.gateway": { latency: [53, 66, 90], dropped: 12 } },
      server: { "no-cache": [0.5, 0.5, 0.5] },
    });
    const evaluation = evaluateRun(run);
    const noCache = evaluation.scenarios.find((s) => s.name === "no-cache");
    expect(noCache?.notes.join("\n")).toMatch(/dropped 12 iterations/);
    expect(noCache?.notes.join("\n")).toMatch(/differ by 5.5 ms/);
    expect(evaluation.invalidReasons).toHaveLength(1);
  });

  it("computes the cache hit ratio only from labelled responses", () => {
    const labelled = makeRun({
      id: "fixture-c",
      summaries: {
        "exact-cache.gateway": { latency: [2, 3, 4], cache: { hit: 99, miss: 1, unlabelled: 0 } },
      },
    });
    expect(evaluateScenario(labelled, "exact-cache").cacheHitRatio).toBeCloseTo(0.99);
    const before009 = makeRun({
      id: "fixture-u",
      summaries: {
        "exact-cache.gateway": { latency: [2, 3, 4], cache: { hit: 0, miss: 0, unlabelled: 50 } },
      },
    });
    expect(evaluateScenario(before009, "exact-cache").cacheHitRatio).toBeNull();
  });
});

describe("targets (AC-8)", () => {
  const targetsOf = (run: ReturnType<typeof makeRun>) =>
    Object.fromEntries(evaluateRun(run).targets.map((t) => [t.id, t]));

  it("marks T1 and T2 met when the measured values meet them", () => {
    const targets = targetsOf(makeRun({ id: "fixture-met", summaries: passing }));
    expect(targets.T1).toMatchObject({ value: 6, status: "met" });
    expect(targets.T2).toMatchObject({ status: "met" });
    expect(targets.T2?.value).toBeCloseTo(99.9167, 3);
  });

  it("marks them missed otherwise, exactly at the threshold for T1", () => {
    const targets = targetsOf(
      makeRun({
        id: "fixture-missed",
        summaries: {
          ...passing,
          "no-cache.gateway": { latency: [60, 75, 99] },
          "chaos.gateway": { latency: [55, 70, 300], requests: 1000, ok: 980, failed: 20 },
        },
      }),
    );
    expect(targets.T1).toMatchObject({ value: 15, status: "missed" });
    expect(targets.T2).toMatchObject({ value: 98, status: "missed" });
  });

  it("does not evaluate a target whose scenario was not run or failed correctness", () => {
    const targets = targetsOf(
      makeRun({
        id: "fixture-ne",
        summaries: { "no-cache.gateway": { latency: [1, 2, 3] } },
        status: { "no-cache": "correctness-failed" },
      }),
    );
    expect(targets.T1).toMatchObject({
      status: "not evaluated",
      reason: "scenario correctness-failed",
    });
    expect(targets.T2).toMatchObject({ status: "not evaluated", reason: "scenario not run" });
  });
});

describe("rate-limit bound (AC-3 rate-limited, AC-4)", () => {
  it("allows the initial capacity plus the refill over the scenario", () => {
    // 60 rpm over 150 s: 60 + 150 = 210.
    expect(checkRateLimit({ admitted: 210, rejected: 540, rpm: 60, totalSeconds: 150 })).toEqual({
      ok: true,
      bound: 210,
      problem: null,
    });
  });

  it("fails above the bound or when nothing was rejected", () => {
    expect(
      checkRateLimit({ admitted: 211, rejected: 5, rpm: 60, totalSeconds: 150 }).problem,
    ).toMatch(/above the bound of 210/);
    expect(checkRateLimit({ admitted: 7, rejected: 0, rpm: 6, totalSeconds: 7 }).problem).toMatch(
      /never exceeded/,
    );
  });
});
