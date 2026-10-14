// What `pnpm bench` runs for each scenario (spec 012, AC-2, AC-3): k6 passes and their
// environment, and how a pass's exit maps to correctness vs harness failures (AC-4).
import { BASELINE_SCENARIOS, type ScenarioName, type ScenarioParams } from "./config.ts";
import type { PassTarget, ScenarioStatus } from "./types.ts";

/** Hosts on the Compose network (bench/compose.bench.yml). */
export const HOSTS = {
  gateway: "http://gateway:8080",
  gatewayCache: "http://gateway-cache:8080",
  mock: "http://mock-upstream:9100",
} as const;

export interface BenchKeys {
  /** High limits and a large budget: never throttles, but the budget path still runs. */
  main: string;
  /** The rate-limited scenario's key, with the scenario's rpm. */
  limited: string;
}

export interface PassPlan {
  scenario: ScenarioName;
  target: PassTarget;
  /** Path of the k6 script inside the k6 container. */
  script: string;
  env: Record<string, string>;
}

function gatewayEnv(scenario: ScenarioName, params: ScenarioParams, keys: BenchKeys) {
  switch (scenario) {
    case "exact-cache":
      return {
        BASE_URL: HOSTS.gatewayCache,
        MODEL: "upstream/bench",
        API_KEY: keys.main,
        REQUIRE_CACHE_HEADER: String(params.requireCacheHeader === true),
      };
    case "rate-limited":
      return { BASE_URL: HOSTS.gateway, MODEL: "upstream/bench", API_KEY: keys.limited };
    case "chaos":
      return { BASE_URL: HOSTS.gateway, MODEL: "bench-chaos", API_KEY: keys.main };
    default:
      return { BASE_URL: HOSTS.gateway, MODEL: "upstream/bench", API_KEY: keys.main };
  }
}

/** The direct baseline (when the scenario has one) runs before the gateway pass (ADR-0021). */
export function planScenario(
  scenario: ScenarioName,
  params: ScenarioParams,
  keys: BenchKeys,
): PassPlan[] {
  const load = {
    RATE: String(params.rate),
    WARMUP_SECONDS: String(params.warmupSeconds),
    STEADY_SECONDS: String(params.steadySeconds),
    PRE_ALLOCATED_VUS: String(params.preAllocatedVUs),
    MAX_VUS: String(params.maxVUs),
  };
  const script = `/scripts/${scenario}.js`;
  const passes: PassPlan[] = [];
  if (BASELINE_SCENARIOS.includes(scenario)) {
    passes.push({
      scenario,
      target: "direct",
      script,
      env: { ...load, MODE: "direct", BASE_URL: HOSTS.mock, MODEL: "bench" },
    });
  }
  passes.push({
    scenario,
    target: "gateway",
    script,
    env: { ...load, MODE: "gateway", ...gatewayEnv(scenario, params, keys) },
  });
  return passes;
}

/** k6 exits 99 when a threshold fails; only `correctness_errors` has one (AC-4). */
export const K6_THRESHOLD_EXIT = 99;

export function classifyPass(exitCode: number | null, hasSummary: boolean): ScenarioStatus {
  if (!hasSummary) return "harness-error";
  if (exitCode === 0) return "passed";
  if (exitCode === K6_THRESHOLD_EXIT) return "correctness-failed";
  return "harness-error";
}

const SEVERITY: Record<ScenarioStatus, number> = {
  passed: 0,
  "correctness-failed": 1,
  "harness-error": 2,
};

export function worst(statuses: readonly ScenarioStatus[]): ScenarioStatus {
  return statuses.reduce<ScenarioStatus>(
    (acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc),
    "passed",
  );
}
