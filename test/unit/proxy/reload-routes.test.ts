import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/load.js";
import type { RateLimiter } from "../../../src/core/ratelimit.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { createConfigRuntime } from "../../../src/modules/config/runtime.js";
import { testApp } from "../../helpers/app.js";
import { spiedRegistry } from "../../helpers/providers.js";

const yaml = (options: { maxAttempts: number; aliases: string; rpm?: number; pii?: string }) => `
providers:
  mock: { type: mock }
  ollama: { type: openai-compatible, baseUrl: "http://ollama.test/v1" }
  openrouter: { type: openai-compatible, baseUrl: "http://openrouter.test/v1" }
  claude: { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
aliases:
${options.aliases}
retry: { maxAttempts: ${options.maxAttempts} }
limits: { defaults: { rpm: ${options.rpm ?? 1000} } }
pii: { defaultMode: ${options.pii ?? "off"} }
usage: { enabled: false }
`;

const broken = "  broken: { strategy: priority, candidates: [mock/error-500] }";
const fresh = "  fresh: { strategy: priority, candidates: [ollama/llama3.2] }";

describe("requests read the config snapshot (spec 008, AC-12)", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  async function setup(limiter: RateLimiter = new MemoryRateLimiter()) {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-routes-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "switchyard.yaml");
    writeFileSync(path, yaml({ maxAttempts: 3, aliases: broken }));
    const config = loadConfig(path, {});
    const { registry, spies } = spiedRegistry();
    const runtime = createConfigRuntime({
      initial: { config, providers: registry },
      source: { path, env: {} },
      buildProviders: () => registry,
      logger: { info: () => {}, warn: () => {} } as never,
    });
    const { app } = await testApp({ config, providers: registry, runtime, limiter });
    cleanup.push(() => app.close());
    const chat = (model: string, content = "hello") =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model, messages: [{ role: "user", content }] },
      });
    const rewrite = (text: string) => {
      writeFileSync(path, text);
      return runtime.reload();
    };
    return { chat, rewrite, spies };
  }

  it("serves a new alias and new retry settings after a reload", async () => {
    const { chat, rewrite } = await setup();
    expect((await chat("fresh")).statusCode).toBe(404);
    expect((await chat("broken")).headers["x-switchyard-attempts"]).toBe("3");

    expect(rewrite(yaml({ maxAttempts: 1, aliases: `${broken}\n${fresh}` })).result).toBe(
      "reloaded",
    );
    const res = await chat("fresh");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-provider"]).toBe("ollama");
    expect((await chat("broken")).headers["x-switchyard-attempts"]).toBe("1");
  });

  it("a request in flight during a reload finishes with the config it started with", async () => {
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const atAdmission = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const inner = new MemoryRateLimiter();
    const gated: RateLimiter = {
      take: async (buckets) => {
        if (release === undefined) {
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          arrived?.();
          await gate;
        }
        return inner.take(buckets);
      },
      adjust: (a) => inner.adjust(a),
      peek: (k, c) => inner.peek(k, c),
    };
    const { chat, rewrite } = await setup(gated);

    const inFlight = chat("broken");
    await atAdmission;
    rewrite(yaml({ maxAttempts: 1, aliases: broken }));
    release?.();

    expect((await inFlight).headers["x-switchyard-attempts"]).toBe("3");
    expect((await chat("broken")).headers["x-switchyard-attempts"]).toBe("1");
  });

  it("applies reloaded rate limits and PII settings to new requests", async () => {
    const { chat, rewrite, spies } = await setup();
    rewrite(yaml({ maxAttempts: 1, aliases: fresh, rpm: 1, pii: "block" }));
    const blocked = await chat("fresh", "write to ana@example.com");
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("pii_detected");
    expect(spies.ollama?.requests).toHaveLength(0);
    expect((await chat("fresh")).statusCode).toBe(429);
  });
});
