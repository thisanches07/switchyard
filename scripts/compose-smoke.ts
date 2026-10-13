// Smoke test for the Docker Compose stack (spec 001: AC-1..AC-6, AC-9; specs 002-003: chat,
// streaming and embeddings via the mock provider; spec 004: API keys through the admin API;
// spec 005: per-minute rate limits; spec 006: usage events through Redpanda and the worker).
// Cross-platform: `node scripts/compose-smoke.ts [--down]` locally (Windows or Linux) and in CI.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { totalMemoryBytes } from "./lib/stack-memory.ts";

const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? "http://localhost:8080";
const MAX_STACK_GIB = Number(process.env.SMOKE_MAX_STACK_GIB ?? "4");
// Compose ships this dev-only default (spec 004); override with ADMIN_TOKEN like the stack does.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-only-admin-token-change-me";
let apiKey = "";
let apiKeyId = "";
const authed = () => ({ "content-type": "application/json", authorization: `Bearer ${apiKey}` });
const root = resolve(import.meta.dirname, "..");
const down = process.argv.includes("--down");

const failures: string[] = [];

function run(args: string[], opts: { allowFailure?: boolean; timeoutMs?: number } = {}) {
  // A hung Docker call fails the step instead of blocking the smoke test forever.
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 600_000,
  });
  const timedOut = result.error !== undefined && result.signal !== null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${timedOut ? "\n(timed out)" : ""}`;
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

  await step("a /v1 request without an API key gets 401", async () => {
    const res = await fetch(`${GATEWAY}/v1/models`);
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });

  await step("the admin API creates a team and an API key", async () => {
    const admin = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    const team = await fetch(`${GATEWAY}/admin/teams`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: `smoke-${Date.now()}` }),
    });
    if (team.status !== 201) throw new Error(`team: ${team.status} ${await team.text()}`);
    const { id } = (await team.json()) as { id: string };
    const key = await fetch(`${GATEWAY}/admin/keys`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ teamId: id, name: "smoke" }),
    });
    if (key.status !== 201) throw new Error(`key: ${key.status} ${await key.text()}`);
    ({ key: apiKey, id: apiKeyId } = (await key.json()) as { key: string; id: string });
  });

  await step("POST /v1/chat/completions through the mock provider returns 200", async () => {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "mock/smoke", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${res.status} ${body}`);
    if (res.headers.get("x-switchyard-provider") !== "mock")
      throw new Error("missing provider header");
  });

  await step("streamed chat completion arrives as SSE ending with [DONE]", async () => {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "mock/smoke",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${res.status} ${body}`);
    if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw new Error(`unexpected content-type ${res.headers.get("content-type")}`);
    }
    if (!body.trimEnd().endsWith("data: [DONE]")) throw new Error(body.slice(-200));
  });

  await step("POST /v1/embeddings through the mock provider returns 768-dim vectors", async () => {
    const res = await fetch(`${GATEWAY}/v1/embeddings`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "mock/smoke", input: "hi", encoding_format: "float" }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${res.status} ${body}`);
    const length = JSON.parse(body).data?.[0]?.embedding?.length;
    if (length !== 768) throw new Error(`embedding length ${length}`);
  });

  await step("a key limited to 2 requests per minute gets 200, 200, then 429", async () => {
    const admin = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    const team = await fetch(`${GATEWAY}/admin/teams`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: `smoke-limits-${Date.now()}` }),
    });
    const { id } = (await team.json()) as { id: string };
    const created = await fetch(`${GATEWAY}/admin/keys`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ teamId: id, name: "limited", rpm: 2 }),
    });
    const { key } = (await created.json()) as { key: string };
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 3; i += 1) {
      last = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "mock/smoke", messages: [{ role: "user", content: "hi" }] }),
      });
      statuses.push(last.status);
    }
    if (statuses.join(",") !== "200,200,429") throw new Error(`statuses ${statuses.join(",")}`);
    if (Number(last?.headers.get("retry-after")) < 1) throw new Error("missing retry-after");
    if (last?.headers.get("x-ratelimit-remaining-requests") !== "0") {
      throw new Error("missing x-ratelimit-remaining-requests: 0");
    }
  });

  await step("the usage worker created the usage and DLQ topics", () => {
    const topics = run(["compose", "exec", "-T", "redpanda", "rpk", "topic", "list"]).stdout;
    for (const topic of ["usage.events.v1", "usage.events.dlq"]) {
      if (!topics.includes(topic)) throw new Error(`missing topic ${topic}:\n${topics}`);
    }
  });

  await step("a chat request is counted in GET /admin/usage?groupBy=key within 10 s", async () => {
    const usageOf = async () => {
      const res = await fetch(`${GATEWAY}/admin/usage?groupBy=key`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (res.status !== 200) throw new Error(`usage: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data: { group: string; requests: number }[] };
      return body.data.find((row) => row.group === apiKeyId)?.requests ?? 0;
    };
    const before = await usageOf();
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ model: "mock/smoke", messages: [{ role: "user", content: "hi" }] }),
    });
    if (res.status !== 200) throw new Error(`chat: ${res.status} ${await res.text()}`);
    const started = Date.now();
    let after = before;
    while (after <= before && Date.now() - started < 10_000) {
      await new Promise((r) => setTimeout(r, 250));
      after = await usageOf();
    }
    if (after <= before) throw new Error(`request not counted after 10 s (still ${after})`);
    console.log(`  counted after ${Date.now() - started} ms (${after} requests for the key)`);
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
      { allowFailure: true, timeoutMs: 120_000 },
    );
    if (result.status === 0) throw new Error("gateway started with an invalid config");
    if (result.status === null) throw new Error(`compose run did not finish: ${result.output}`);
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
    for (const service of ["gateway", "usage-worker"]) {
      console.error(`\n--- ${service} logs ---`);
      console.error(
        run(["compose", "logs", "--no-color", "--tail", "50", service], {
          allowFailure: true,
        }).output,
      );
    }
  }
  if (down) run(["compose", "down", "-v"], { allowFailure: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke step(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nCompose smoke test passed.");
