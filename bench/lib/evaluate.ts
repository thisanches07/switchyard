// Turns a run's raw results into the published statistics and target verdicts (spec 012,
// AC-4, AC-7, AC-8). Pure: everything comes from the run folder, including its own config copy.
import type { BenchConfig, ProfileName, ScenarioName } from "./config.ts";
import { BASELINE_SCENARIOS, SCENARIOS } from "./config.ts";
import { counter, type K6Summary, type Percentiles, type TrendStats, trend } from "./k6-summary.ts";
import type {
  Environment,
  PassTarget,
  RunRecord,
  ScenarioStatus,
  ServerMetricsFile,
  ServerOverhead,
} from "./types.ts";

/** Everything read from one run folder. */
export interface RunData {
  id: string;
  environment: Environment;
  run: RunRecord;
  config: BenchConfig;
  /** Keyed `<scenario>.<target>`. */
  summaries: Record<string, K6Summary>;
  serverMetrics: ServerMetricsFile | null;
}

export interface PassStats {
  latency: TrendStats | null;
  ttfb: TrendStats | null;
  /** Steady-phase requests answered (all statuses). */
  requests: number;
  ok: number;
  failed: number;
  rejected: number;
  rejectLatency: TrendStats | null;
  /** Steady requests per second actually achieved. */
  achievedRate: number;
  droppedIterations: number;
  correctnessErrors: number;
  cache: { hit: number; miss: number; unlabelled: number };
}

export interface ScenarioResult {
  name: ScenarioName;
  status: ScenarioStatus | "not-run";
  problems: string[];
  gateway: PassStats | null;
  direct: PassStats | null;
  /** Gateway percentile minus direct percentile (difference of percentiles, ADR-0021). */
  clientOverhead: Percentiles | null;
  /** Streaming: the same on time to first byte. */
  clientTtfbOverhead: Percentiles | null;
  serverOverhead: ServerOverhead | null;
  /** ok ÷ requests through the gateway, in percent. */
  successPct: number | null;
  /** hit ÷ labelled responses; null when no response carried `x-switchyard-cache`. */
  cacheHitRatio: number | null;
  notes: string[];
}

export type TargetStatus = "met" | "missed" | "not evaluated";

export interface TargetResult {
  id: "T1" | "T2";
  description: string;
  value: number | null;
  unit: "ms" | "%";
  threshold: number;
  status: TargetStatus;
  reason: string | null;
}

export interface RunEvaluation {
  scenarios: ScenarioResult[];
  targets: TargetResult[];
  /** Load-generator saturation etc.: the run is not a valid measurement (ADR-0021). */
  invalidReasons: string[];
}

/** Client and server p95 overheads further apart than this are called out in the report. */
export const DISAGREEMENT_MS = 5;

export function passStats(summary: K6Summary, steadySeconds: number): PassStats {
  const requests = counter(summary, "bench_requests");
  return {
    latency: trend(summary, "bench_latency"),
    ttfb: trend(summary, "bench_ttfb"),
    requests,
    ok: counter(summary, "bench_ok"),
    failed: counter(summary, "bench_failed"),
    rejected: counter(summary, "bench_rejected"),
    rejectLatency: trend(summary, "bench_reject_latency"),
    achievedRate: steadySeconds > 0 ? requests / steadySeconds : 0,
    droppedIterations: counter(summary, "dropped_iterations"),
    correctnessErrors: counter(summary, "correctness_errors"),
    cache: {
      hit: counter(summary, "bench_cache_hit"),
      miss: counter(summary, "bench_cache_miss"),
      unlabelled: counter(summary, "bench_cache_unlabelled"),
    },
  };
}

export function percentileDifference(
  gateway: Percentiles | null,
  direct: Percentiles | null,
): Percentiles | null {
  if (!gateway || !direct) return null;
  return {
    p50: gateway.p50 - direct.p50,
    p95: gateway.p95 - direct.p95,
    p99: gateway.p99 - direct.p99,
  };
}

export interface RateLimitCheck {
  ok: boolean;
  bound: number;
  problem: string | null;
}

/**
 * Spec 012 AC-3 `rate-limited`: a token bucket of `rpm` units, full at the first request and
 * refilled at rpm/60 per second, admits at most `rpm × (1 + seconds/60)` requests over the
 * whole scenario (warm-up included). At least one request must have been rejected, or the load
 * did not exceed the limit and the scenario proved nothing.
 */
export function checkRateLimit(input: {
  admitted: number;
  rejected: number;
  rpm: number;
  totalSeconds: number;
}): RateLimitCheck {
  const bound = Math.ceil(input.rpm * (1 + input.totalSeconds / 60));
  if (input.admitted > bound) {
    return {
      ok: false,
      bound,
      problem: `admitted ${input.admitted} requests, above the bound of ${bound}`,
    };
  }
  if (input.rejected === 0) {
    return {
      ok: false,
      bound,
      problem: "no request was rejected: the load never exceeded the limit",
    };
  }
  return { ok: true, bound, problem: null };
}

function profileOf(data: RunData): ProfileName {
  return data.run.profile;
}

export function evaluateScenario(data: RunData, name: ScenarioName): ScenarioResult {
  const record = data.run.scenarios.find((s) => s.name === name);
  const params = data.config.profiles[profileOf(data)].scenarios[name];
  const stats = (target: PassTarget) => {
    const summary = data.summaries[`${name}.${target}`];
    return summary ? passStats(summary, params.steadySeconds) : null;
  };
  const gateway = record ? stats("gateway") : null;
  const direct = record && BASELINE_SCENARIOS.includes(name) ? stats("direct") : null;
  const serverOverhead = data.serverMetrics?.scenarios[name] ?? null;
  const clientOverhead = percentileDifference(gateway?.latency ?? null, direct?.latency ?? null);
  const clientTtfbOverhead = percentileDifference(gateway?.ttfb ?? null, direct?.ttfb ?? null);
  // Server-side overhead of a stream stops at the first byte (spec 011), so compare it with the
  // client-side TTFB difference, not with the whole-stream difference.
  const comparableClientOverhead = name === "streaming" ? clientTtfbOverhead : clientOverhead;
  const notes: string[] = [];

  for (const [target, pass] of [
    ["gateway", gateway],
    ["direct", direct],
  ] as const) {
    if (pass && pass.droppedIterations > 0) {
      notes.push(
        `${target}: k6 dropped ${pass.droppedIterations} iterations (load generator saturated)`,
      );
    }
  }
  if (comparableClientOverhead && serverOverhead?.p95 != null) {
    const gap = Math.abs(comparableClientOverhead.p95 - serverOverhead.p95);
    if (gap > DISAGREEMENT_MS) {
      notes.push(
        `client-side and server-side p95 overhead differ by ${gap.toFixed(1)} ms (> ${DISAGREEMENT_MS} ms)`,
      );
    }
  }

  const labelled = gateway ? gateway.cache.hit + gateway.cache.miss : 0;
  return {
    name,
    status: record?.status ?? "not-run",
    problems: record?.problems ?? [],
    gateway,
    direct,
    clientOverhead,
    clientTtfbOverhead,
    serverOverhead,
    successPct: gateway && gateway.requests > 0 ? (gateway.ok / gateway.requests) * 100 : null,
    cacheHitRatio:
      name === "exact-cache" && labelled > 0 ? (gateway?.cache.hit ?? 0) / labelled : null,
    notes,
  };
}

function target(
  id: TargetResult["id"],
  description: string,
  unit: TargetResult["unit"],
  threshold: number,
  scenario: ScenarioResult | undefined,
  value: number | null,
  meets: (value: number) => boolean,
): TargetResult {
  const base = { id, description, unit, threshold };
  if (!scenario || scenario.status === "not-run") {
    return { ...base, value: null, status: "not evaluated", reason: "scenario not run" };
  }
  if (scenario.status !== "passed") {
    return { ...base, value, status: "not evaluated", reason: `scenario ${scenario.status}` };
  }
  if (value === null) {
    return { ...base, value, status: "not evaluated", reason: "no measurement" };
  }
  return { ...base, value, status: meets(value) ? "met" : "missed", reason: null };
}

export function evaluateTargets(
  scenarios: readonly ScenarioResult[],
  targets: BenchConfig["targets"],
): TargetResult[] {
  const noCache = scenarios.find((s) => s.name === "no-cache");
  const chaos = scenarios.find((s) => s.name === "chaos");
  return [
    target(
      "T1",
      `p95 gateway overhead below ${targets.t1MaxOverheadP95Ms} ms (no-cache, client-side)`,
      "ms",
      targets.t1MaxOverheadP95Ms,
      noCache,
      noCache?.clientOverhead?.p95 ?? null,
      (value) => value < targets.t1MaxOverheadP95Ms,
    ),
    target(
      "T2",
      `at least ${targets.t2MinSuccessPct} % success with a primary failing 30 % (chaos)`,
      "%",
      targets.t2MinSuccessPct,
      chaos,
      chaos?.successPct ?? null,
      (value) => value >= targets.t2MinSuccessPct,
    ),
  ];
}

export function evaluateRun(data: RunData): RunEvaluation {
  const scenarios = SCENARIOS.map((name) => evaluateScenario(data, name));
  const invalidReasons = scenarios.flatMap((s) =>
    s.notes.filter((n) => n.includes("dropped")).map((n) => `${s.name} ${n}`),
  );
  return { scenarios, targets: evaluateTargets(scenarios, data.config.targets), invalidReasons };
}
