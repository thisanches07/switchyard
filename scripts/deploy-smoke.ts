// Smoke test for the production Compose profile (spec 013: AC-4, AC-5, AC-6), run in CI by the
// deploy workflow after loading locally built amd64 images tagged
// ghcr.io/thisanches07/switchyard-{gateway,worker}:<package.json version>.
//   node scripts/deploy-smoke.ts [--down]
// Linux only: the admin API is reached at the gateway's fixed compose address (172.30.0.10), as
// an operator does through an SSH tunnel; the public side goes through Caddy on 80/443.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, request } from "undici";

const root = resolve(import.meta.dirname, "..");
const down = process.argv.includes("--down");
const version = (
  JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }
).version;
const HTTPS = "https://localhost";
const ADMIN = "http://172.30.0.10:8080";
// Caddy's internal CA signs the localhost certificate; trust it for this test only.
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

const secrets = {
  ADMIN_TOKEN: randomBytes(32).toString("hex"),
  KEY_PEPPER: randomBytes(32).toString("hex"),
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
};
const dir = mkdtempSync(join(tmpdir(), "switchyard-deploy-"));
const envFile = join(dir, "switchyard.env");
const envLines = (values: Record<string, string>) =>
  `${Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
writeFileSync(
  envFile,
  envLines({ SWITCHYARD_VERSION: version, SWITCHYARD_HOSTNAME: "localhost", ...secrets }),
);

const composeArgs = (env = envFile) => [
  "compose",
  "-f",
  "deploy/compose/compose.yml",
  "-f",
  "test/deploy/compose.test.yml",
  "--env-file",
  env,
];

function docker(args: string[], opts: { allowFailure?: boolean; timeoutMs?: number } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 600_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed (${result.status}):\n${output}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", output };
}

const failures: string[] = [];
async function step(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function https(
  path: string,
  init: { method?: "GET" | "POST"; key?: string; body?: unknown } = {},
) {
  const res = await request(`${HTTPS}${path}`, {
    method: init.method ?? "GET",
    dispatcher: insecure,
    headers: {
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.statusCode, headers: res.headers, body: await res.body.text() };
}

const chat = (key: string, model = "demo", stream = false) =>
  https("/v1/chat/completions", {
    method: "POST",
    key,
    body: { model, stream, messages: [{ role: "user", content: "hi" }] },
  });

const errorCode = (body: string) => {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

/** Runs `pnpm demo:key` (plain Node) against the admin API; returns stdout (the key, if any). */
function demoKey(args: string[]): string {
  const result = spawnSync(process.execPath, ["scripts/demo-key.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SWITCHYARD_ADMIN_URL: ADMIN, ADMIN_TOKEN: secrets.ADMIN_TOKEN },
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`demo:key ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  }
  console.log(`  demo:key: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

try {
  await step("Compose refuses to start when a secret is missing (AC-4)", () => {
    const partial = join(dir, "partial.env");
    writeFileSync(
      partial,
      envLines({ SWITCHYARD_VERSION: version, SWITCHYARD_HOSTNAME: "localhost" }),
    );
    const result = docker([...composeArgs(partial), "config", "--quiet"], { allowFailure: true });
    if (result.status === 0) throw new Error("compose accepted an env file without secrets");
    if (!/set (ADMIN_TOKEN|KEY_PEPPER|POSTGRES_PASSWORD) in the env file/.test(result.output)) {
      throw new Error(result.output);
    }
  });

  await step("the gateway refuses the dev defaults of docker-compose.yml (AC-4)", () => {
    const result = docker(
      [
        ...composeArgs(),
        "run",
        "--rm",
        "--no-deps",
        "-e",
        "ADMIN_TOKEN=dev-only-admin-token-change-me",
        "-e",
        "KEY_PEPPER=dev-only-pepper-change-me-0123456789abcdef",
        "gateway",
      ],
      { allowFailure: true, timeoutMs: 120_000 },
    );
    if (result.status === 0 || result.status === null) {
      throw new Error(`gateway did not refuse (status ${result.status}): ${result.output}`);
    }
    for (const expected of [
      "ADMIN_TOKEN: is a dev-only default",
      "KEY_PEPPER: is a dev-only default",
    ]) {
      if (!result.output.includes(expected))
        throw new Error(`missing "${expected}":\n${result.output}`);
    }
  });

  await step("production stack starts from the versioned images (docker compose up --wait)", () => {
    docker([...composeArgs(), "up", "-d", "--no-build", "--wait", "--wait-timeout", "300"]);
  });

  await step("GET /healthz answers 200 through Caddy over HTTPS on 443 (AC-5)", async () => {
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const res = await https("/healthz");
        if (res.status === 200 && JSON.parse(res.body).status === "ok") return;
        last = `${res.status} ${res.body}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(1_000);
    }
    throw new Error(`no healthy answer over HTTPS: ${last}`);
  });

  await step("plain HTTP on 80 redirects to HTTPS (AC-5)", async () => {
    const res = await request("http://localhost/healthz", { method: "GET" });
    await res.body.text();
    const location = String(res.headers.location ?? "");
    if (res.statusCode < 300 || res.statusCode > 399 || !location.startsWith("https://localhost")) {
      throw new Error(`status ${res.statusCode}, location "${location}"`);
    }
  });

  await step(
    "only 80 and 443 are published; other ports refuse connections (AC-4, AC-5)",
    async () => {
      // Compose prints one JSON object per line (older versions: one JSON array).
      type Container = { Publishers?: { PublishedPort: number }[] | null };
      const out = docker([...composeArgs(), "ps", "--format", "json"]).stdout.trim();
      const containers: Container[] = out.startsWith("[")
        ? (JSON.parse(out) as Container[])
        : out
            .split("\n")
            .filter((l) => l.trim().startsWith("{"))
            .map((l) => JSON.parse(l) as Container);
      const published = new Set<number>();
      for (const container of containers) {
        for (const p of container.Publishers ?? []) {
          if (p.PublishedPort > 0) published.add(p.PublishedPort);
        }
      }
      const sorted = [...published].sort((a, b) => a - b);
      if (sorted.join(",") !== "80,443") throw new Error(`published ports: ${sorted.join(",")}`);
      const open: number[] = [];
      for (const port of [
        2019, 3000, 4317, 4318, 5432, 6379, 8080, 9092, 9644, 11434, 19092, 55432,
      ]) {
        if (await tcpOpen(port)) open.push(port);
      }
      if (open.length > 0) throw new Error(`unexpected open host ports: ${open.join(",")}`);
    },
  );

  await step("the admin API is not exposed through Caddy", async () => {
    const res = await https("/admin/teams");
    if (res.status !== 404) throw new Error(`${res.status} ${res.body}`);
  });

  await step("the usage worker reports it started (spec 006 readiness)", async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const logs = docker([...composeArgs(), "logs", "--no-color", "usage-worker"]).stdout;
      if (logs.includes("usage worker started")) return;
      if (Date.now() > deadline) throw new Error("no 'usage worker started' log line in 60 s");
      await sleep(2_000);
    }
  });

  await step("demo key: 200 up to its rpm, then 429 rate_limit_exceeded (AC-6)", async () => {
    const key = demoKey(["--team", "demo-rate", "--rpm", "3", "--budget-usd", "1000"]);
    if (!key.startsWith("sk-sy-")) throw new Error(`no key printed: "${key}"`);
    const statuses: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await chat(key);
      statuses.push(res.status === 200 ? "200" : `${res.status} ${errorCode(res.body)}`);
    }
    if (statuses.join(",") !== "200,200,200,429 rate_limit_exceeded") {
      throw new Error(`statuses ${statuses.join(",")}`);
    }
  });

  await step("demo:key is idempotent: a second run prints no new key (AC-6)", async () => {
    const again = demoKey(["--team", "demo-rate", "--rpm", "3", "--budget-usd", "1000"]);
    if (again !== "") throw new Error("a second run printed a key");
    const admin = { authorization: `Bearer ${secrets.ADMIN_TOKEN}` };
    const teams = await (await fetch(`${ADMIN}/admin/teams`, { headers: admin })).json();
    const team = (teams as { data: { id: string; name: string }[] }).data.find(
      (t) => t.name === "demo-rate",
    );
    if (!team) throw new Error("team demo-rate not found");
    const keys = (await (
      await fetch(`${ADMIN}/admin/keys?teamId=${team.id}`, { headers: admin })
    ).json()) as { data: { status: string }[] };
    const active = keys.data.filter((k) => k.status === "active").length;
    if (active !== 1) throw new Error(`${active} active keys`);
  });

  await step("demo key: other models get 403, streams pass through Caddy (AC-6)", async () => {
    const key = demoKey(["--team", "demo-models", "--rpm", "20", "--budget-usd", "1000"]);
    const other = await chat(key, "mock/smoke");
    if (other.status !== 403 || errorCode(other.body) !== "model_not_allowed") {
      throw new Error(`other model: ${other.status} ${other.body}`);
    }
    const stream = await chat(key, "demo", true);
    if (stream.status !== 200 || !stream.body.trimEnd().endsWith("data: [DONE]")) {
      throw new Error(`stream: ${stream.status} ${stream.body.slice(-200)}`);
    }
  });

  await step("demo key: 429 budget_exceeded once its hard budget is spent (AC-6)", async () => {
    const key = demoKey(["--team", "demo-budget", "--rpm", "100", "--budget-usd", "1"]);
    const statuses: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const res = await chat(key);
      statuses.push(res.status === 200 ? "200" : `${res.status} ${errorCode(res.body)}`);
      if (res.status !== 200) break;
      await sleep(200);
    }
    const last = statuses.at(-1);
    if (statuses[0] !== "200" || last !== "429 budget_exceeded") {
      throw new Error(`statuses ${statuses.join(",")}`);
    }
    console.log(`  budget spent after ${statuses.length - 1} requests`);
  });
} finally {
  if (failures.length > 0) {
    for (const service of ["caddy", "gateway", "usage-worker"]) {
      console.error(`\n--- ${service} logs ---`);
      console.error(
        docker([...composeArgs(), "logs", "--no-color", "--tail", "60", service], {
          allowFailure: true,
        }).output,
      );
    }
  }
  if (down) docker([...composeArgs(), "down", "-v"], { allowFailure: true });
  rmSync(dir, { recursive: true, force: true });
  await insecure.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} deploy smoke step(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nProduction Compose smoke test passed.");
