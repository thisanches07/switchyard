import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const server = resolve(root, "src/server.ts");

const baseEnv = {
  DATABASE_URL: "postgres://switchyard:switchyard@127.0.0.1:1/switchyard",
  REDIS_URL: "redis://127.0.0.1:1",
  SWITCHYARD_CONFIG: resolve(root, "config/switchyard.example.yaml"),
  OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
  OTEL_SDK_DISABLED: "true",
  HOST: "127.0.0.1",
  PORT: "0",
};

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function start(env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  const child = spawn(process.execPath, ["--import", "tsx", server], {
    cwd: root,
    env: merged,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const exited = new Promise<number | null>((r) => child.once("exit", r));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

describe("server boot", () => {
  it("exits non-zero with readable error on invalid config", async () => {
    const run = start({
      ...baseEnv,
      SWITCHYARD_CONFIG: resolve(root, "test/fixtures/config/unknown-provider.yaml"),
    });
    expect(await run.exited).toBe(1);
    const { stderr } = run.output();
    expect(stderr).toContain("Invalid configuration in");
    expect(stderr).toContain('aliases.fast.candidates[0]: unknown provider "grok"');
    expect(stderr).not.toMatch(/at .*\.ts:\d+/); // no stack trace
  }, 20_000);

  it("exits non-zero when DATABASE_URL is missing", async () => {
    const run = start({ ...baseEnv, DATABASE_URL: undefined });
    expect(await run.exited).toBe(1);
    expect(run.output().stderr).toContain("Invalid configuration in environment");
    expect(run.output().stderr).toContain("DATABASE_URL");
  }, 20_000);

  it("starts and serves /healthz even when dependencies are down", async () => {
    const run = start(baseEnv);
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setInterval(() => {
        const match = run.output().stdout.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearInterval(timer);
          resolveUrl(match[1]);
        }
      }, 50);
      run.exited.then((code) => {
        clearInterval(timer);
        reject(new Error(`server exited with ${code}: ${run.output().stderr}`));
      });
    });

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${url}/readyz`);
    expect(ready.status).toBe(503);
  }, 20_000);
});
