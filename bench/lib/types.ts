// Shapes of the files in a run folder (spec 012, AC-5). Bump `schema` on incompatible changes.
import type { ProfileName, ScenarioName } from "./config.ts";

export type PassTarget = "direct" | "gateway";
export type ScenarioStatus = "passed" | "correctness-failed" | "harness-error";

/** One k6 execution of a scenario against one target. */
export interface PassRecord {
  target: PassTarget;
  /** k6 exit code; 99 means a threshold (correctness) failed; null when k6 did not run. */
  exitCode: number | null;
  /** Raw k6 summary, relative to the run folder (`k6/<scenario>.<target>.json`). */
  file: string | null;
  startedAt: string;
  steadyStartedAt: string;
  finishedAt: string;
}

export interface ScenarioRecord {
  name: ScenarioName;
  status: ScenarioStatus;
  /** Correctness or harness problems, without response content. */
  problems: string[];
  passes: PassRecord[];
}

/** `run.json`. */
export interface RunRecord {
  schema: 1;
  runId: string;
  profile: ProfileName;
  scenarios: ScenarioRecord[];
}

/** Server-side gateway overhead over a scenario's window, in milliseconds (`null`: unknown). */
export interface ServerOverhead {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Requests in the window according to the histogram. */
  count: number | null;
  /** Why values are missing (e.g. "metric not exported"); null when present. */
  reason: string | null;
  queries: string[];
}

/** `server-metrics.json`. */
export interface ServerMetricsFile {
  schema: 1;
  prometheusUrl: string;
  scenarios: Partial<Record<ScenarioName, ServerOverhead>>;
}

/** `environment.json`. */
export interface Environment {
  schema: 1;
  runId: string;
  kind: ProfileName;
  /** Only fixture folders under test/fixtures set this; such runs are never published. */
  fixture?: boolean;
  startedAt: string;
  finishedAt: string | null;
  host: {
    cpuModel: string;
    cpuCores: number;
    ramBytes: number;
    os: { platform: string; release: string; version: string };
  };
  docker: {
    clientVersion: string | null;
    serverVersion: string | null;
    operatingSystem: string | null;
    ncpu: number | null;
    memTotalBytes: number | null;
  };
  node: string;
  k6: { image: string; digest: string | null; version: string | null };
  images: { gateway: string | null; mockUpstream: string | null };
  git: { commit: string; dirty: boolean };
  configHash: string;
  publishable: boolean;
  notPublishableReasons: string[];
}
