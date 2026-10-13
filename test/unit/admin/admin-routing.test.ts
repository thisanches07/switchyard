import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/load.js";
import { createConfigRuntime } from "../../../src/modules/config/runtime.js";
import { testApp } from "../../helpers/app.js";
import { TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";
import { spiedRegistry } from "../../helpers/providers.js";

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

const yaml = (aliases: string, extra = "") => `
providers:
  mock: { type: mock }
  ollama: { type: openai-compatible, baseUrl: "http://ollama.test/v1" }
  openrouter: { type: openai-compatible, baseUrl: "http://openrouter.test/v1" }
  claude: { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
aliases:
${aliases}
circuitBreaker: { failureThreshold: 2, openMs: 30000 }
usage: { enabled: false }
${extra}
`;
const aliases = `  broken: { strategy: priority, candidates: [mock/error-500, ollama/llama3.2] }`;

describe("admin routing endpoints (spec 008)", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-admin-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "switchyard.yaml");
    writeFileSync(path, yaml(aliases));
    const config = loadConfig(path, {});
    const { registry } = spiedRegistry();
    const runtime = createConfigRuntime({
      initial: { config, providers: registry },
      source: { path, env: {} },
      buildProviders: () => registry,
      logger: { info: () => {}, warn: () => {} } as never,
    });
    const { app, key } = await testApp({
      config,
      providers: registry,
      runtime,
      adminToken: TEST_ADMIN_TOKEN,
      authenticated: false,
    });
    cleanup.push(() => app.close());
    const chat = (model: string) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model, messages: [{ role: "user", content: "hi" }] },
        headers: { authorization: `Bearer ${key}` },
      });
    const get = (headers = admin) =>
      app.inject({ method: "GET", url: "/admin/providers/health", headers });
    const reload = (headers = admin) =>
      app.inject({ method: "POST", url: "/admin/config/reload", headers });
    return { chat, get, reload, rewrite: (text: string) => writeFileSync(path, text) };
  }

  describe("GET /admin/providers/health (AC-11)", () => {
    it("reports every alias candidate, cold and closed before any traffic", async () => {
      const { get } = await setup();
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.json();
      expect(body.scope).toBe("instance");
      expect(body.note).toMatch(/per gateway instance|each gateway instance/);
      expect(body.data).toEqual([
        {
          candidate: "mock/error-500",
          state: "closed",
          consecutiveFailures: 0,
          halfOpenAt: null,
          latencyMs: { ewma: null, samples: 0 },
          errorRate: 0,
          window: 0,
        },
        expect.objectContaining({ candidate: "ollama/llama3.2", state: "closed" }),
      ]);
    });

    it("shows an open breaker, its half-open time, latency samples and error rate", async () => {
      const { chat, get } = await setup();
      // Each request: error-500 fails, ollama answers. Two requests open error-500's breaker.
      await chat("broken");
      await chat("broken");
      const rows = get().then((r) => r.json().data as Record<string, unknown>[]);
      const [failing, healthy] = await rows;
      expect(failing).toMatchObject({
        candidate: "mock/error-500",
        state: "open",
        consecutiveFailures: 2,
        errorRate: 1,
        window: 2,
      });
      expect(Date.parse(failing?.halfOpenAt as string)).toBeGreaterThan(Date.now());
      expect(healthy).toMatchObject({ state: "closed", errorRate: 0, window: 2 });
      expect(healthy?.latencyMs).toMatchObject({ samples: 2 });
    });

    it("lists plain provider/model candidates once they have been called", async () => {
      const { chat, get } = await setup();
      await chat("openrouter/some/model");
      const refs = (await get()).json().data.map((r: { candidate: string }) => r.candidate);
      expect(refs).toContain("openrouter/some/model");
    });

    it("requires the admin token", async () => {
      const { get } = await setup();
      expect((await get({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    });
  });

  describe("POST /admin/config/reload (AC-12, AC-13)", () => {
    it("reports unchanged, then reloaded with the settings that need a restart", async () => {
      const { reload, rewrite, chat } = await setup();
      expect((await reload()).json()).toEqual({ result: "unchanged", restartRequired: [] });
      rewrite(
        yaml(
          `${aliases}\n  fresh: { strategy: priority, candidates: [ollama/llama3.2] }`,
          "server: { trustProxy: true }",
        ),
      );
      const res = await reload();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ result: "reloaded", restartRequired: ["server.trustProxy"] });
      expect((await chat("fresh")).statusCode).toBe(200);
    });

    it("400 invalid_config with the issues; the previous config keeps serving", async () => {
      const { reload, rewrite, chat } = await setup();
      rewrite(yaml(`  broken: { strategy: priority, candidates: [grok/x] }`));
      const res = await reload();
      expect(res.statusCode).toBe(400);
      const { error } = res.json();
      expect(error).toMatchObject({ type: "invalid_request_error", code: "invalid_config" });
      expect(error.issues).toEqual([
        { path: "aliases.broken.candidates[0]", message: expect.stringContaining('"grok"') },
      ]);
      expect((await chat("broken")).statusCode).toBe(200);
    });

    it("requires the admin token", async () => {
      const { reload } = await setup();
      expect((await reload({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    });
  });
});
