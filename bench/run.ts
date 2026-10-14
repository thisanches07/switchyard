// `pnpm bench [-- --scenario <name>] [--smoke] [--keep]` (spec 012, AC-2, AC-5).
// Starts the bench stack (gateway from the production Dockerfile, mock upstreams, telemetry),
// creates the benchmark keys through the admin API, runs every scenario with the pinned k6
// image, collects server-side metrics, writes the run folder and stops what it started.
// Cross-platform (Windows Docker Desktop and Linux): Node built-ins and the docker CLI only.
import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "./lib/args.ts";
import {
  BENCH_CONFIG_PATH,
  configHash,
  loadBenchConfig,
  type ProfileName,
  ROOT,
  readConfigFiles,
  type ScenarioName,
} from "./lib/config.ts";
import {
  hostFacts,
  parseDocker,
  publishability,
  repoDigest,
  runFolder,
  runId,
} from "./lib/environment.ts";
import { checkRateLimit, type RunData } from "./lib/evaluate.ts";
import { counter, extractSummary, type K6Summary } from "./lib/k6-summary.ts";
import { collectServerOverhead } from "./lib/metrics.ts";
import { type BenchKeys, classifyPass, planScenario, worst } from "./lib/plan.ts";
import { renderRunSummary } from "./lib/render.ts";
import { ensureDir, FILES, writeJson } from "./lib/runs.ts";
import type {
  Environment,
  PassRecord,
  RunRecord,
  ScenarioRecord,
  ScenarioStatus,
  ServerMetricsFile,
} from "./lib/types.ts";

const PROJECT = "switchyard-bench";
const GATEWAY = process.env.BENCH_GATEWAY_URL ?? "http://127.0.0.1:8080";
const PROMETHEUS = `http://127.0.0.1:${process.env.BENCH_PROMETHEUS_PORT ?? "9090"}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-only-admin-token-change-me";

const args = parseArgs(process.argv.slice(2));
const profile: ProfileName = args.smoke ? "smoke" : "full";
const config = loadBenchConfig();
const params = config.profiles[profile];

const composeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  K6_IMAGE: config.k6Image,
  MOCK_LATENCY_MS: String(config.mock.latencyMs),
  MOCK_CHUNK_DELAY_MS: String(config.mock.chunkDelayMs),
  MOCK_FLAKY_ERROR_RATE: String(config.mock.flakyErrorRate),
};

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function command(
  file: string,
  argv: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): CommandResult {
  const result = spawnSync(file, argv, {
    cwd: ROOT,
    encoding: "utf8",
    env: options.env ?? composeEnv,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
  if (out.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${file} ${argv.join(" ")} failed (${out.status}):\n${out.stdout}${out.stderr}`,
    );
  }
  return out;
}

const docker = (argv: string[], options: Parameters<typeof command>[2] = {}) =>
  command("docker", argv, options);
const compose = (argv: string[], options: Parameters<typeof command>[2] = {}) =>
  docker(
    [
      "compose",
      "-p",
      PROJECT,
      "-f",
      "docker-compose.yml",
      "-f",
      "bench/compose.bench.yml",
      ...argv,
    ],
    options,
  );
const git = (argv: string[]) => command("git", argv, { env: process.env }).stdout.trim();

async function admin(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`POST ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function createKeys(id: string): Promise<BenchKeys> {
  const team = await admin("/admin/teams", { name: `bench-${id}` });
  const teamId = String(team.id);
  // High limits so `main` never trips (AC-3 no-cache); a budget so the budget check still runs.
  const main = await admin("/admin/keys", {
    teamId,
    name: "bench-main",
    rpm: 1_000_000,
    tpm: 1_000_000_000,
    monthlyBudgetUsd: "99999999",
  });
  const limited = await admin("/admin/keys", {
    teamId,
    name: "bench-limited",
    rpm: params.scenarios["rate-limited"].rpm,
    tpm: 1_000_000_000,
  });
  return { main: String(main.key), limited: String(limited.key) };
}

function tail(text: string, lines: number): string {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

const startedAt = new Date();
const commit = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain"]).length > 0;
const id = runId(startedAt, commit);
const publish = publishability(profile, dirty);
const dir = runFolder(ROOT, id, profile, publish);
ensureDir(join(dir, FILES.k6Dir));
console.log(`Benchmark run ${id} (${profile}) -> ${relative(ROOT, dir)}`);
if (!publish.publishable) console.log(`Not publishable: ${publish.reasons.join("; ")}`);

const environment: Environment = {
  schema: 1,
  runId: id,
  kind: profile,
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  host: hostFacts(),
  docker: {
    clientVersion: null,
    serverVersion: null,
    operatingSystem: null,
    ncpu: null,
    memTotalBytes: null,
  },
  node: process.version,
  k6: { image: config.k6Image, digest: null, version: null },
  images: { gateway: null, mockUpstream: null },
  git: { commit, dirty },
  configHash: configHash(readConfigFiles()),
  publishable: publish.publishable,
  notPublishableReasons: publish.reasons,
};
const run: RunRecord = { schema: 1, runId: id, profile, scenarios: [] };
const serverMetrics: ServerMetricsFile = { schema: 1, prometheusUrl: PROMETHEUS, scenarios: {} };
const summaries: Record<string, K6Summary> = {};
const harnessErrors: string[] = [];

async function runScenario(name: ScenarioName, keys: BenchKeys): Promise<ScenarioRecord> {
  const scenario = params.scenarios[name];
  const record: ScenarioRecord = { name, status: "passed", problems: [], passes: [] };
  const statuses: ScenarioStatus[] = [];
  const phaseSeconds = scenario.warmupSeconds + scenario.steadySeconds;
  for (const pass of planScenario(name, scenario, keys)) {
    console.log(
      `\n▶ ${name} (${pass.target}): ${scenario.rate} req/s, ${scenario.warmupSeconds} s warm-up + ${scenario.steadySeconds} s steady`,
    );
    const passStarted = new Date();
    const result = compose(
      [
        "--profile",
        "tools",
        "run",
        "--rm",
        "-T",
        ...Object.entries(pass.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "k6",
        "run",
        "--quiet",
        "--no-color",
        pass.script,
      ],
      {
        env: { ...composeEnv, ...pass.env },
        timeoutMs: (phaseSeconds + 180) * 1000,
        allowFailure: true,
      },
    );
    const finished = new Date();
    let summary: K6Summary | undefined;
    try {
      summary = extractSummary(result.stdout);
    } catch (error) {
      record.problems.push(
        `${pass.target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const file = summary ? `${FILES.k6Dir}/${name}.${pass.target}.json` : null;
    if (summary && file) {
      summaries[`${name}.${pass.target}`] = summary;
      writeJson(join(dir, file), summary);
    }
    // k6's own run duration places the steady phase precisely, despite container start-up time.
    const runMs = (summary?.state as { testRunDurationMs?: number } | undefined)?.testRunDurationMs;
    const k6Start = runMs ? new Date(finished.getTime() - runMs) : passStarted;
    const steadyStarted = new Date(k6Start.getTime() + scenario.warmupSeconds * 1000);
    const passRecord: PassRecord = {
      target: pass.target,
      exitCode: result.status,
      file,
      startedAt: passStarted.toISOString(),
      steadyStartedAt: steadyStarted.toISOString(),
      finishedAt: finished.toISOString(),
    };
    record.passes.push(passRecord);
    const status = classifyPass(result.status, summary !== undefined);
    statuses.push(status);
    const errors = summary ? counter(summary, "correctness_errors") : 0;
    console.log(`  exit ${result.status}; correctness errors: ${errors}; status: ${status}`);
    if (status !== "passed") {
      record.problems.push(`${pass.target}: k6 exited ${result.status} (${status})`);
      console.log(tail(result.stderr, 30));
    }

    if (name === "rate-limited" && pass.target === "gateway" && summary) {
      const check = checkRateLimit({
        admitted: counter(summary, "bench_admitted_total"),
        rejected: counter(summary, "bench_rejected_total"),
        rpm: scenario.rpm ?? 0,
        totalSeconds: phaseSeconds,
      });
      console.log(
        `  rate limit: ${check.ok ? "within" : "VIOLATES"} the bound of ${check.bound} admitted`,
      );
      if (!check.ok && check.problem) {
        record.problems.push(check.problem);
        statuses.push("correctness-failed");
      }
    }

    if (pass.target === "gateway") {
      // The gateway exports metrics every 15 s: wait so the window is complete in Prometheus.
      await sleep(params.serverMetricsLagSeconds * 1000);
      const overhead = await collectServerOverhead({
        prometheusUrl: PROMETHEUS,
        metric: config.serverMetrics.metric,
        selector: config.serverMetrics.selectors[name],
        windowStart: steadyStarted,
        evaluateAt: new Date(),
      });
      serverMetrics.scenarios[name] = overhead;
      console.log(
        `  server-side overhead p95: ${overhead.p95 === null ? `n/a (${overhead.reason})` : `${overhead.p95.toFixed(2)} ms`}`,
      );
    }
  }
  record.status = worst(statuses);
  return record;
}

let exitCode = 0;
try {
  const info = docker(["info", "--format", "{{json .}}"], { allowFailure: true });
  const version = docker(["version", "--format", "{{json .}}"], { allowFailure: true });
  environment.docker = parseDocker(info.stdout, version.stdout);
  if (info.status !== 0) throw new Error(`Docker is not available:\n${info.stderr}`);

  console.log("Starting the bench stack (builds the gateway from the production Dockerfile)…");
  try {
    compose(["up", "-d", "--build", "--wait", "--wait-timeout", "300"], { timeoutMs: 1_500_000 });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nIf a port is already allocated, stop the dev stack first (docker compose down).`,
    );
  }
  const imageId = (image: string) =>
    docker(["image", "inspect", image, "--format", "{{.Id}}"], {
      allowFailure: true,
    }).stdout.trim() || null;
  environment.images = {
    gateway: imageId("switchyard-gateway:dev"),
    mockUpstream: imageId("switchyard-mock-upstream:bench"),
  };
  docker(["pull", "--quiet", config.k6Image], { timeoutMs: 600_000 });
  environment.k6.digest = repoDigest(
    docker(["image", "inspect", config.k6Image, "--format", "{{json .RepoDigests}}"], {
      allowFailure: true,
    }).stdout,
  );
  environment.k6.version =
    compose(["--profile", "tools", "run", "--rm", "-T", "k6", "version"], {
      allowFailure: true,
    }).stdout.trim() || null;

  const keys = await createKeys(id);
  for (const name of args.scenarios) {
    const record = await runScenario(name, keys);
    run.scenarios.push(record);
    if (record.status !== "passed") exitCode = 1;
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  harnessErrors.push(message);
  console.error(`\nHarness error: ${message}`);
} finally {
  environment.finishedAt = new Date().toISOString();
  if (harnessErrors.length > 0) {
    run.scenarios.push(
      ...args.scenarios
        .filter((name) => !run.scenarios.some((s) => s.name === name))
        .map((name) => ({
          name,
          status: "harness-error" as const,
          problems: harnessErrors,
          passes: [],
        })),
    );
  }
  writeJson(join(dir, FILES.environment), environment);
  writeJson(join(dir, FILES.run), run);
  writeJson(join(dir, FILES.serverMetrics), serverMetrics);
  copyFileSync(BENCH_CONFIG_PATH, join(dir, FILES.config));
  const data: RunData = { id, environment, run, config, summaries, serverMetrics };
  try {
    const summary = renderRunSummary(data, { runs: {} });
    writeFileSync(join(dir, FILES.summary), summary);
    console.log(`\n${summary}`);
  } catch (error) {
    console.error(
      `could not write summary.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (exitCode !== 0) {
    for (const service of ["gateway", "gateway-cache", "mock-upstream"]) {
      console.error(`\n--- ${service} logs ---`);
      console.error(
        tail(
          compose(["logs", "--no-color", "--tail", "40", service], { allowFailure: true }).stdout,
          40,
        ),
      );
    }
  }
  if (!args.keep)
    compose(["down", "-v", "--remove-orphans"], { allowFailure: true, timeoutMs: 300_000 });
}

console.log(`\nRun folder: ${relative(ROOT, dir)}`);
if (exitCode !== 0) {
  console.error("Benchmark run FAILED (correctness or harness error); see above.");
  process.exit(1);
}
if (publish.publishable) {
  console.log("Next: commit the run folder, then `pnpm bench:report` (see docs/benchmarks.md).");
}
