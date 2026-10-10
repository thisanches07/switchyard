// Smoke test for the Docker Compose stack (spec 001: AC-1..AC-6, AC-9; spec 002: chat via mock).
// Cross-platform: `node scripts/compose-smoke.ts [--down]` locally (Windows or Linux) and in CI.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { totalMemoryBytes } from "./lib/stack-memory.ts";

const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? "http://localhost:8080";
const MAX_STACK_GIB = Number(process.env.SMOKE_MAX_STACK_GIB ?? "4");
const root = resolve(import.meta.dirname, "..");
const down = process.argv.includes("--down");

const failures: string[] = [];

function run(args: string[], opts: { allowFailure?: boolean } = {}) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed (${result.status}):\n${output}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", output };
}

async function step(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getWithRetry(path: string, expected: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${GATEWAY}${path}`);
      const body = await res.text();
      if (res.status === expected) return body;
      last = `${res.status} ${body}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`GET ${path} did not return ${expected}: ${last}`);
}

try {
  await step("stack starts (docker compose up --wait)", () => {
    run(["compose", "up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
  });

  await step("GET /healthz returns 200", async () => {
    const body = await getWithRetry("/healthz", 200);
    if (JSON.parse(body).status !== "ok") throw new Error(`unexpected body ${body}`);
  });

  await step("GET /readyz returns 200 with Postgres and Redis ok", async () => {
    const body = await getWithRetry("/readyz", 200);
    const checks = JSON.parse(body).checks;
    if (checks.postgres !== "ok" || checks.redis !== "ok") throw new Error(body);
  });

  await step("POST /v1/chat/completions through the mock provider returns 200", async () => {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/smoke", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${res.status} ${body}`);
    if (res.headers.get("x-switchyard-provider") !== "mock")
      throw new Error("missing provider header");
  });

  await step("ollama profile adds the ollama service", () => {
    const services = run(["compose", "--profile", "ollama", "config", "--services"]).stdout;
    if (!services.split(/\r?\n/).includes("ollama")) throw new Error(services);
    const defaults = run(["compose", "config", "--services"]).stdout;
    if (defaults.split(/\r?\n/).includes("ollama")) {
      throw new Error("ollama must not start by default");
    }
  });

  await step("invalid config exits non-zero with a readable error", () => {
    // The example config resolves the Ollama URL from OLLAMA_BASE_URL; an empty value is invalid.
    const result = run(
      ["compose", "run", "--rm", "--no-deps", "-e", "OLLAMA_BASE_URL=", "gateway"],
      { allowFailure: true },
    );
    if (result.status === 0) throw new Error("gateway started with an invalid config");
    if (!result.output.includes("Invalid configuration in")) throw new Error(result.output);
  });

  await step(`stack memory at idle stays under ${MAX_STACK_GIB} GiB`, () => {
    const ids = run(["compose", "ps", "-q"]).stdout.split(/\r?\n/).filter(Boolean);
    const usage = run(["stats", "--no-stream", "--format", "{{.MemUsage}}", ...ids])
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    const gib = totalMemoryBytes(usage) / 1024 ** 3;
    console.log(`  stack memory: ${gib.toFixed(2)} GiB across ${ids.length} containers`);
    if (gib >= MAX_STACK_GIB) throw new Error(`${gib.toFixed(2)} GiB >= ${MAX_STACK_GIB} GiB`);
  });

  await step("gateway exits 0 within 10 s on SIGTERM", () => {
    const started = Date.now();
    run(["compose", "stop", "--timeout", "15", "gateway"]);
    const elapsed = Date.now() - started;
    const name = run(["compose", "ps", "-a", "--format", "{{.Name}}", "gateway"])
      .stdout.split(/\r?\n/)
      .find((n) => n.endsWith("-gateway-1"));
    if (!name) throw new Error("gateway container not found");
    const code = run(["inspect", name, "--format", "{{.State.ExitCode}}"]).stdout.trim();
    console.log(`  stopped in ${elapsed} ms with exit code ${code}`);
    if (code !== "0") throw new Error(`exit code ${code}`);
    if (elapsed >= 10_000) throw new Error(`took ${elapsed} ms`);
  });
} finally {
  if (failures.length > 0) {
    console.error("\n--- gateway logs ---");
    console.error(
      run(["compose", "logs", "--no-color", "--tail", "50", "gateway"], {
        allowFailure: true,
      }).output,
    );
  }
  if (down) run(["compose", "down", "-v"], { allowFailure: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke step(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nCompose smoke test passed.");
