// Benchmark configuration (spec 012, ADR-0021): scenario parameters per profile, k6 image, targets.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SCENARIOS = ["no-cache", "exact-cache", "streaming", "rate-limited", "chaos"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];
export type ProfileName = "full" | "smoke";

/** Scenarios that are paired with a direct-to-mock baseline in the same run (ADR-0021). */
export const BASELINE_SCENARIOS: readonly ScenarioName[] = ["no-cache", "streaming"];

export interface ScenarioParams {
  rate: number;
  warmupSeconds: number;
  steadySeconds: number;
  preAllocatedVUs: number;
  maxVUs: number;
  /** rate-limited only: the limited key's requests per minute. */
  rpm?: number;
  /** exact-cache only: a response without `x-switchyard-cache` is a correctness error. */
  requireCacheHeader?: boolean;
}

export interface ProfileConfig {
  serverMetricsLagSeconds: number;
  scenarios: Record<ScenarioName, ScenarioParams>;
}

export interface BenchConfig {
  k6Image: string;
  mock: { latencyMs: number; chunkDelayMs: number; flakyErrorRate: number };
  targets: { t1MaxOverheadP95Ms: number; t2MinSuccessPct: number };
  serverMetrics: { metric: string; selectors: Record<ScenarioName, string> };
  profiles: Record<ProfileName, ProfileConfig>;
}

export const ROOT = resolve(import.meta.dirname, "../..");
export const BENCH_CONFIG_PATH = resolve(ROOT, "bench/bench.config.json");

/** Files whose content defines the benchmark setup; their hash goes in environment.json. */
export const CONFIG_FILES = [
  "bench/bench.config.json",
  "bench/config/gateway.yaml",
  "bench/config/gateway-cache.yaml",
  "bench/compose.bench.yml",
];

export function loadBenchConfig(path = BENCH_CONFIG_PATH): BenchConfig {
  return parseBenchConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseBenchConfig(raw: unknown): BenchConfig {
  const config = raw as BenchConfig;
  const problems: string[] = [];
  const positive = (value: unknown, where: string, allowZero = false) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && !value))
      problems.push(`${where} must be a ${allowZero ? "non-negative" : "positive"} number`);
  };
  if (typeof config?.k6Image !== "string") problems.push("k6Image must be a string");
  positive(config?.mock?.latencyMs, "mock.latencyMs", true);
  positive(config?.mock?.chunkDelayMs, "mock.chunkDelayMs", true);
  positive(config?.mock?.flakyErrorRate, "mock.flakyErrorRate");
  positive(config?.targets?.t1MaxOverheadP95Ms, "targets.t1MaxOverheadP95Ms");
  positive(config?.targets?.t2MinSuccessPct, "targets.t2MinSuccessPct");
  if (typeof config?.serverMetrics?.metric !== "string") problems.push("serverMetrics.metric");
  for (const scenario of SCENARIOS) {
    if (typeof config?.serverMetrics?.selectors?.[scenario] !== "string") {
      problems.push(`serverMetrics.selectors.${scenario} must be a string`);
    }
  }
  for (const profile of ["full", "smoke"] as const) {
    const p = config?.profiles?.[profile];
    positive(p?.serverMetricsLagSeconds, `profiles.${profile}.serverMetricsLagSeconds`, true);
    for (const scenario of SCENARIOS) {
      const s = p?.scenarios?.[scenario];
      const where = `profiles.${profile}.scenarios.${scenario}`;
      for (const key of ["rate", "warmupSeconds", "steadySeconds", "preAllocatedVUs", "maxVUs"]) {
        positive(s?.[key as keyof ScenarioParams], `${where}.${key}`);
      }
      if (scenario === "rate-limited") positive(s?.rpm, `${where}.rpm`);
      if (scenario === "exact-cache" && typeof s?.requireCacheHeader !== "boolean") {
        problems.push(`${where}.requireCacheHeader must be a boolean`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`Invalid bench config:\n- ${problems.join("\n- ")}`);
  return config;
}

/** SHA-256 over the setup files (line endings normalised), as `sha256:<hex>`. */
export function configHash(files: readonly { path: string; content: string }[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\n`);
    hash.update(file.content.replace(/\r\n/g, "\n"));
    hash.update("\n\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function readConfigFiles(root = ROOT): { path: string; content: string }[] {
  return CONFIG_FILES.map((path) => ({ path, content: readFileSync(resolve(root, path), "utf8") }));
}
