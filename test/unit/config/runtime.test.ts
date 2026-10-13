import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/config/errors.js";
import { type LoadedConfig, loadConfig } from "../../../src/config/load.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import {
  type ConfigRuntime,
  createConfigRuntime,
  pinStartupSettings,
} from "../../../src/modules/config/runtime.js";
import { createProviderRegistry } from "../../../src/modules/providers/registry.js";
import { CandidateHealthRegistry } from "../../../src/modules/routing/health.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";
import { installTestMetrics } from "../../helpers/metrics.js";

const base = `
server:
  bodyLimitBytes: 1000
  trustProxy: false
  timeouts: { connectMs: 1000, ttfbMs: 2000, totalMs: 3000 }
providers:
  mock: { type: mock }
  other: { type: mock, latencyMs: 0 }
aliases:
  fast: { strategy: priority, candidates: [mock/a, other/b] }
usage: { enabled: false }
`;

describe("config runtime (spec 008, AC-12, AC-13)", () => {
  let dir: string;
  let path: string;
  let meters: ReturnType<typeof installTestMetrics>;
  let logs: { level: string; obj: unknown; msg: string }[];
  let builds: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchyard-reload-"));
    path = join(dir, "switchyard.yaml");
    meters = installTestMetrics();
    logs = [];
    builds = 0;
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await meters.uninstall();
  });

  const logger = {
    info: (obj: unknown, msg: string) => logs.push({ level: "info", obj, msg }),
    warn: (obj: unknown, msg: string) => logs.push({ level: "warn", obj, msg }),
  } as never;

  const build = (config: LoadedConfig): ReadonlyMap<string, ChatProvider> => {
    builds += 1;
    return createProviderRegistry(
      config,
      {},
      { http: fakeHttp(() => jsonResponse(500, {})).client },
    );
  };

  function start(text = base): ConfigRuntime {
    writeFileSync(path, text);
    const config = loadConfig(path, {});
    return createConfigRuntime({
      initial: { config, providers: build(config) },
      source: { path, env: {} },
      buildProviders: build,
      logger,
    });
  }

  const reloads = async (result: string) =>
    (await meters.points("switchyard_config_reloads_total"))
      .filter((p) => p.attributes.result === result)
      .reduce((sum, p) => sum + Number(p.value), 0);

  it("reports unchanged when the content is the same, even after a rewrite", () => {
    const runtime = start();
    const before = runtime.current();
    writeFileSync(path, base);
    expect(runtime.reload()).toEqual({ result: "unchanged", restartRequired: [] });
    expect(runtime.current()).toBe(before);
  });

  it("swaps in a new snapshot for new requests; the old one is left untouched", async () => {
    const runtime = start();
    const before = runtime.current();
    writeFileSync(path, base.replace("[mock/a, other/b]", "[other/b]"));
    expect(runtime.reload()).toEqual({ result: "reloaded", restartRequired: [] });
    expect(runtime.current().config.aliases.fast?.candidates).toEqual(["other/b"]);
    expect(before.config.aliases.fast?.candidates).toEqual(["mock/a", "other/b"]);
    expect(await reloads("success")).toBe(1);
    expect(logs.some((l) => l.level === "info" && l.msg === "config reloaded")).toBe(true);
  });

  it("keeps settings fixed at startup and says they need a restart", () => {
    const runtime = start();
    writeFileSync(
      path,
      base
        .replace("bodyLimitBytes: 1000", "bodyLimitBytes: 5000")
        .replace("trustProxy: false", "trustProxy: true")
        .replace("connectMs: 1000", "connectMs: 9000")
        .replace("ttfbMs: 2000", "ttfbMs: 2500"),
    );
    const result = runtime.reload();
    expect(result.restartRequired).toEqual([
      "server.bodyLimitBytes",
      "server.trustProxy",
      "server.timeouts.connectMs",
    ]);
    const { server } = runtime.current().config;
    expect(server).toMatchObject({ bodyLimitBytes: 1000, trustProxy: false });
    expect(server.timeouts).toEqual({ connectMs: 1000, ttfbMs: 2500, totalMs: 3000 });
    expect(logs).toContainEqual({
      level: "warn",
      obj: { settings: result.restartRequired },
      msg: "config reload: these settings need a restart to change",
    });
  });

  it("reuses provider instances whose definition is unchanged", () => {
    const runtime = start();
    const before = runtime.current().providers;
    writeFileSync(
      path,
      base.replace("other: { type: mock, latencyMs: 0 }", "other: { type: mock, latencyMs: 5 }"),
    );
    runtime.reload();
    const after = runtime.current().providers;
    expect(after.get("mock")).toBe(before.get("mock"));
    expect(after.get("other")).not.toBe(before.get("other"));
    expect(builds).toBe(2);
  });

  it("notifies listeners so breaker state survives only for unchanged providers", () => {
    const runtime = start();
    const health = new CandidateHealthRegistry({
      settings: () => runtime.current().config,
      logger: { warn: () => {} } as never,
    });
    runtime.onChange((prev, next) => health.retain(prev, next));
    health.get("mock/a").recordLatency(10);
    health.get("other/b").recordLatency(10);
    writeFileSync(
      path,
      base.replace("other: { type: mock, latencyMs: 0 }", "other: { type: mock, latencyMs: 5 }"),
    );
    runtime.reload();
    expect(health.peek("mock/a")?.ewma).toBe(10);
    expect(health.peek("other/b")).toBeUndefined();
  });

  it.each([
    ["invalid YAML", "providers: [\n", /YAML syntax error/],
    ["a schema error", `${base}\nretry: { maxAttempts: 0 }\n`, /retry\.maxAttempts/],
  ])("keeps the previous config on %s and counts a failure", async (_, text, pattern) => {
    const runtime = start();
    const before = runtime.current();
    writeFileSync(path, text);
    const error = (() => {
      try {
        runtime.reload();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(JSON.stringify((error as ConfigError).issues)).toMatch(pattern);
    expect(runtime.current()).toBe(before);
    expect(await reloads("failure")).toBe(1);
    expect(logs.find((l) => l.level === "warn")?.msg).toBe(
      "config reload failed: keeping the previous config",
    );

    // Fixing the file applies it.
    writeFileSync(path, base.replace("[mock/a, other/b]", "[mock/a]"));
    expect(runtime.reload().result).toBe("reloaded");
  });

  it("logs issue paths and messages, never the offending values", () => {
    const runtime = start();
    writeFileSync(
      path,
      base.replace(
        "{ type: mock }",
        "{ type: openai-compatible, apiKeyEnv: sk-live-SECRET-123 , baseUrl: 'http://x.test' }",
      ),
    );
    expect(() => runtime.reload()).toThrow(ConfigError);
    expect(JSON.stringify(logs)).not.toContain("SECRET-123");
    expect(JSON.stringify(logs)).toContain("providers.mock.apiKeyEnv");
  });

  it("a missing file is a reload failure", () => {
    const runtime = start();
    rmSync(path);
    expect(() => runtime.reload()).toThrow(/file not found/);
  });

  it("without a source there is nothing to reload", () => {
    writeFileSync(path, base);
    const config = loadConfig(path, {});
    const runtime = createConfigRuntime({
      initial: { config, providers: new Map() },
      buildProviders: build,
      logger,
    });
    expect(runtime.reload()).toEqual({ result: "unchanged", restartRequired: [] });
  });
});

describe("pinStartupSettings", () => {
  it("lists and restores every setting bound at startup", () => {
    const parse = (text: string) => {
      const dir = mkdtempSync(join(tmpdir(), "switchyard-pin-"));
      const file = join(dir, "c.yaml");
      writeFileSync(file, text);
      try {
        return loadConfig(file, {});
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const prev = parse(base);
    const next = parse(
      `${base.replace("usage: { enabled: false }", "usage: { enabled: true, topic: other }")}
limits: { authFailuresPerMinutePerIp: 99 }
pricingFile: elsewhere.yaml
`,
    );
    const { config, restartRequired } = pinStartupSettings(prev, next);
    expect(restartRequired).toEqual(["limits.authFailuresPerMinutePerIp", "usage", "pricingFile"]);
    expect(config.usage).toEqual(prev.usage);
    expect(config.pricingFile).toBe(prev.pricingFile);
    expect(config.limits.authFailuresPerMinutePerIp).toBe(prev.limits.authFailuresPerMinutePerIp);
  });
});
