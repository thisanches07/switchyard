// Run folders (spec 012, AC-5, AC-6, AC-9): reading them for the report, writing them for a run.
// Every committed clean full run under bench/results/ is published; nothing is selected away.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBenchConfig } from "./config.ts";
import type { RunData } from "./evaluate.ts";
import { isSummary, type K6Summary } from "./k6-summary.ts";
import type { Environment, RunRecord, ServerMetricsFile } from "./types.ts";

export const FILES = {
  environment: "environment.json",
  run: "run.json",
  config: "bench.config.json",
  serverMetrics: "server-metrics.json",
  summary: "summary.md",
  k6Dir: "k6",
} as const;

/** Git-ignored folder for smoke and dirty-tree runs, skipped by the report. */
export const LOCAL_DIR = "local";

export interface ExcludedRun {
  id: string;
  reasons: string[];
}

export interface LoadedRuns {
  runs: RunData[];
  excluded: ExcludedRun[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadRunFolder(dir: string, id: string): RunData {
  const environment = readJson(join(dir, FILES.environment)) as Environment;
  const run = readJson(join(dir, FILES.run)) as RunRecord;
  if (environment?.schema !== 1 || run?.schema !== 1) throw new Error("unsupported schema");
  const config = parseBenchConfig(readJson(join(dir, FILES.config)));
  const serverPath = join(dir, FILES.serverMetrics);
  const serverMetrics = existsSync(serverPath) ? (readJson(serverPath) as ServerMetricsFile) : null;
  const summaries: Record<string, K6Summary> = {};
  const k6Dir = join(dir, FILES.k6Dir);
  if (existsSync(k6Dir)) {
    for (const file of readdirSync(k6Dir).filter((f) => f.endsWith(".json"))) {
      const summary = readJson(join(k6Dir, file));
      if (isSummary(summary)) summaries[file.slice(0, -".json".length)] = summary;
    }
  }
  return { id, environment, run, config, summaries, serverMetrics };
}

/** Why a run must not be published; empty when it may be. */
export function exclusionReasons(data: RunData, allowFixtures: boolean): string[] {
  const reasons: string[] = [];
  const env = data.environment;
  if (env.fixture && !allowFixtures) reasons.push("test fixture, not a measurement");
  if (env.kind !== "full") reasons.push(`${env.kind} run`);
  if (env.git?.dirty) reasons.push("git working tree was dirty");
  if (env.publishable === false && reasons.length === 0) {
    reasons.push(...(env.notPublishableReasons ?? ["marked not publishable"]));
  }
  if (env.runId !== data.id) reasons.push(`folder name differs from runId ${env.runId}`);
  return reasons;
}

/** Every run folder of `dir` (except `local/`), split into published and excluded runs. */
export function loadRuns(dir: string, options: { allowFixtures?: boolean } = {}): LoadedRuns {
  const loaded: LoadedRuns = { runs: [], excluded: [] };
  if (!existsSync(dir)) return loaded;
  const ids = readdirSync(dir)
    .filter((name) => name !== LOCAL_DIR && statSync(join(dir, name)).isDirectory())
    .sort();
  for (const id of ids) {
    let data: RunData;
    try {
      data = loadRunFolder(join(dir, id), id);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      loaded.excluded.push({ id, reasons: [`unreadable: ${message}`] });
      continue;
    }
    const reasons = exclusionReasons(data, options.allowFixtures ?? false);
    if (reasons.length > 0) loaded.excluded.push({ id, reasons });
    else loaded.runs.push(data);
  }
  return loaded;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
