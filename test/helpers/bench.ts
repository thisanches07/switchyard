// Builders for synthetic benchmark results (spec 012 tests). FIXTURE values only: none of these
// numbers is a measurement, and they must never be copied into docs or bench/results.
import type { BenchConfig, ScenarioName } from "../../bench/lib/config.ts";
import { loadBenchConfig, SCENARIOS } from "../../bench/lib/config.ts";
import type { RunData } from "../../bench/lib/evaluate.ts";
import type { K6Metric, K6Summary } from "../../bench/lib/k6-summary.ts";
import type { Environment, RunRecord, ServerOverhead } from "../../bench/lib/types.ts";

type Triple = [number, number, number];

export interface SummarySpec {
  latency?: Triple;
  ttfb?: Triple;
  rejectLatency?: Triple;
  requests?: number;
  ok?: number;
  failed?: number;
  rejected?: number;
  dropped?: number;
  correctness?: number;
  cache?: { hit: number; miss: number; unlabelled: number };
  admittedTotal?: number;
  rejectedTotal?: number;
}

const trendMetric = ([p50, p95, p99]: Triple, count: number): K6Metric => ({
  type: "trend",
  contains: "time",
  values: {
    avg: p50,
    min: p50 / 2,
    med: p50,
    max: p99 * 2,
    "p(50)": p50,
    "p(95)": p95,
    "p(99)": p99,
    count,
  },
});

const counterMetric = (count: number): K6Metric => ({
  type: "counter",
  values: { count, rate: count / 10 },
});

export function makeSummary(spec: SummarySpec): K6Summary {
  const requests = spec.requests ?? 1000;
  const metrics: Record<string, K6Metric> = {
    bench_requests: counterMetric(requests),
    bench_ok: counterMetric(spec.ok ?? requests),
    bench_failed: counterMetric(spec.failed ?? 0),
    bench_rejected: counterMetric(spec.rejected ?? 0),
    correctness_errors: counterMetric(spec.correctness ?? 0),
  };
  if (spec.latency) metrics.bench_latency = trendMetric(spec.latency, requests);
  if (spec.ttfb) metrics.bench_ttfb = trendMetric(spec.ttfb, requests);
  if (spec.rejectLatency) {
    metrics.bench_reject_latency = trendMetric(spec.rejectLatency, spec.rejected ?? 1);
  }
  if (spec.dropped) metrics.dropped_iterations = counterMetric(spec.dropped);
  if (spec.cache) {
    metrics.bench_cache_hit = counterMetric(spec.cache.hit);
    metrics.bench_cache_miss = counterMetric(spec.cache.miss);
    metrics.bench_cache_unlabelled = counterMetric(spec.cache.unlabelled);
  }
  if (spec.admittedTotal !== undefined) {
    metrics.bench_admitted_total = counterMetric(spec.admittedTotal);
  }
  if (spec.rejectedTotal !== undefined) {
    metrics.bench_rejected_total = counterMetric(spec.rejectedTotal);
  }
  return { metrics };
}

export function makeEnvironment(runId: string, overrides: Partial<Environment> = {}): Environment {
  return {
    schema: 1,
    runId,
    kind: "full",
    fixture: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:20:00.000Z",
    host: {
      cpuModel: "FIXTURE CPU (not a real machine)",
      cpuCores: 4,
      ramBytes: 16 * 1024 ** 3,
      os: { platform: "fixture", release: "0", version: "fixture" },
    },
    docker: {
      clientVersion: "0.0.0-fixture",
      serverVersion: "0.0.0-fixture",
      operatingSystem: "fixture",
      ncpu: 4,
      memTotalBytes: 8 * 1024 ** 3,
    },
    node: "v24.0.0-fixture",
    k6: { image: "grafana/k6:fixture", digest: "sha256:fixture", version: "fixture" },
    images: { gateway: "sha256:fixture-gateway", mockUpstream: "sha256:fixture-mock" },
    git: { commit: "f1x7ure000000000000000000000000000000000", dirty: false },
    configHash: "sha256:fixture",
    publishable: true,
    notPublishableReasons: [],
    ...overrides,
  };
}

export function makeServer(p: Triple | null): ServerOverhead {
  return p
    ? { p50: p[0], p95: p[1], p99: p[2], count: 1000, reason: null, queries: [] }
    : { p50: null, p95: null, p99: null, count: null, reason: "metric not exported", queries: [] };
}

export interface RunSpec {
  id: string;
  environment?: Partial<Environment>;
  summaries: Partial<Record<`${ScenarioName}.${"direct" | "gateway"}`, SummarySpec>>;
  server?: Partial<Record<ScenarioName, Triple | null>>;
  status?: Partial<Record<ScenarioName, RunRecord["scenarios"][number]["status"]>>;
  config?: BenchConfig;
}

export function makeRun(spec: RunSpec): RunData {
  const config = spec.config ?? loadBenchConfig();
  const summaries: Record<string, K6Summary> = {};
  for (const [key, value] of Object.entries(spec.summaries)) {
    if (value) summaries[key] = makeSummary(value);
  }
  const scenarios = SCENARIOS.filter((name) => summaries[`${name}.gateway`] !== undefined).map(
    (name) => ({
      name,
      status: spec.status?.[name] ?? ("passed" as const),
      problems: [],
      passes: [],
    }),
  );
  const server: Partial<Record<ScenarioName, ServerOverhead>> = {};
  for (const [name, triple] of Object.entries(spec.server ?? {})) {
    server[name as ScenarioName] = makeServer(triple ?? null);
  }
  return {
    id: spec.id,
    environment: makeEnvironment(spec.id, spec.environment),
    run: { schema: 1, runId: spec.id, profile: "full", scenarios },
    config,
    summaries,
    serverMetrics: { schema: 1, prometheusUrl: "http://fixture", scenarios: server },
  };
}
