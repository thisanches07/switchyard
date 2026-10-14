// Shared k6 harness for the benchmark scenarios (spec 012, ADR-0021).
// Parameters come from environment variables set by bench/run.ts from bench/bench.config.json.
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

export const SUMMARY_BEGIN = "<<<BENCH_SUMMARY_BEGIN>>>";
export const SUMMARY_END = "<<<BENCH_SUMMARY_END>>>";

function env(name, fallback) {
  const value = __ENV[name];
  if (value !== undefined && value !== "") return value;
  if (fallback === undefined) throw new Error(`environment variable ${name} is required`);
  return fallback;
}

function positive(name) {
  const value = Number(env(name));
  if (!(value > 0)) throw new Error(`${name} must be a positive number`);
  return value;
}

/** `gateway` (through Switchyard) or `direct` (straight to the mock upstream: the baseline). */
export const MODE = env("MODE", "gateway");
export const BASE_URL = env("BASE_URL");
export const MODEL = env("MODEL");
const API_KEY = env("API_KEY", "-");

/** Open-model load: warm-up (excluded from results), then the steady phase that is measured. */
export function buildOptions(expectedStatuses = [200]) {
  http.setResponseCallback(http.expectedStatuses(...expectedStatuses));
  const warmup = positive("WARMUP_SECONDS");
  const common = {
    executor: "constant-arrival-rate",
    rate: positive("RATE"),
    timeUnit: "1s",
    preAllocatedVUs: positive("PRE_ALLOCATED_VUS"),
    maxVUs: positive("MAX_VUS"),
  };
  return {
    scenarios: {
      warmup: { ...common, duration: `${warmup}s`, startTime: "0s" },
      steady: { ...common, duration: `${positive("STEADY_SECONDS")}s`, startTime: `${warmup}s` },
    },
    // Correctness, never speed, fails a run (AC-4): k6 exits 99 when this threshold fails.
    thresholds: { correctness_errors: ["count==0"] },
    summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(95)", "p(99)", "count"],
  };
}

export const metrics = {
  correctness: new Counter("correctness_errors"),
  latency: new Trend("bench_latency", true),
  ttfb: new Trend("bench_ttfb", true),
  requests: new Counter("bench_requests"),
  ok: new Counter("bench_ok"),
  failed: new Counter("bench_failed"),
  rejected: new Counter("bench_rejected"),
  rejectLatency: new Trend("bench_reject_latency", true),
  admittedTotal: new Counter("bench_admitted_total"),
  rejectedTotal: new Counter("bench_rejected_total"),
  cacheHit: new Counter("bench_cache_hit"),
  cacheMiss: new Counter("bench_cache_miss"),
  cacheUnlabelled: new Counter("bench_cache_unlabelled"),
};

export function isSteady() {
  return exec.scenario.name === "steady";
}

let reported = 0;

/** Counts a correctness error; logs the first few (status and problem only, never content). */
export function fail(problem, res) {
  metrics.correctness.add(1);
  if (reported < 10) {
    console.error(`correctness: ${problem} (status ${res ? res.status : "n/a"}, ${MODE})`);
    reported += 1;
  }
}

/** POST /v1/chat/completions with the run's key (none for the direct baseline). */
export function chat(body) {
  const headers = { "content-type": "application/json" };
  if (MODE === "gateway") headers.authorization = `Bearer ${API_KEY}`;
  // Keeps every counter in the summary even when it stays at zero.
  metrics.correctness.add(0);
  return http.post(`${BASE_URL}/v1/chat/completions`, JSON.stringify(body), {
    headers,
    timeout: "60s",
  });
}

/** Steady-phase bookkeeping for a request that was answered (successfully or not). */
export function record(res, outcome) {
  if (!isSteady()) return;
  metrics.requests.add(1);
  metrics.ok.add(outcome === "ok" ? 1 : 0);
  metrics.failed.add(outcome === "failed" ? 1 : 0);
  metrics.latency.add(res.timings.duration);
}

/** Raw k6 summary between markers on stdout; bench/run.ts stores it untouched. */
export function summary(data) {
  return { stdout: `\n${SUMMARY_BEGIN}\n${JSON.stringify(data)}\n${SUMMARY_END}\n` };
}
