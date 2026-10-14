import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configHash,
  loadBenchConfig,
  parseBenchConfig,
  readConfigFiles,
  SCENARIOS,
} from "../../../bench/lib/config.ts";
import { loadConfig } from "../../../src/config/load.js";

const root = resolve(import.meta.dirname, "../../..");
const gatewayConfig = (name: string) => resolve(root, "bench/config", name);

describe("bench gateway configs (AC-2, AC-3)", () => {
  it.each(["gateway.yaml", "gateway-cache.yaml"])("%s is a valid gateway config", (name) => {
    const config = loadConfig(gatewayConfig(name), {});
    expect(Object.keys(config.providers).sort()).toEqual(["flaky", "upstream"]);
    expect(config.aliases["bench-chaos"]?.candidates).toEqual(["flaky/bench", "upstream/bench"]);
    // Keys carry their own limits: no default rpm/tpm may throttle the benchmark.
    expect(config.limits.defaults).toEqual({});
    expect(config.cache.semantic.enabled).toBe(false);
  });

  it("disables the exact cache for no-cache and enables it only in gateway-cache", () => {
    const plain = readFileSync(gatewayConfig("gateway.yaml"), "utf8");
    const cached = readFileSync(gatewayConfig("gateway-cache.yaml"), "utf8");
    const body = (text: string) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n");
    expect(body(cached)).toBe(body(plain).replace(/(exact:\n\s+enabled:) false/, "$1 true"));
    expect(body(plain)).toMatch(/exact:\n\s+enabled: false/);
  });
});

describe("bench.config.json (AC-3, ADR-0021)", () => {
  const config = loadBenchConfig();

  it("has full and smoke parameters for every scenario", () => {
    for (const profile of ["full", "smoke"] as const) {
      expect(Object.keys(config.profiles[profile].scenarios).sort()).toEqual([...SCENARIOS].sort());
    }
    expect(config.profiles.full.scenarios["rate-limited"].rpm).toBeGreaterThan(0);
  });

  it("requires the spec 009 cache header and queries spec 011's overhead labels", () => {
    for (const profile of ["full", "smoke"] as const) {
      expect(config.profiles[profile].scenarios["exact-cache"].requireCacheHeader).toBe(true);
    }
    expect(config.serverMetrics.metric).toBe("switchyard_gateway_overhead_seconds");
    expect(config.serverMetrics.selectors["exact-cache"]).toContain('cache="hit"');
    expect(config.serverMetrics.selectors.streaming).toContain('stream="true"');
    expect(config.serverMetrics.selectors["rate-limited"]).toContain('status="2xx"');
  });

  it("pins the k6 image by version tag and digest", () => {
    expect(config.k6Image).toMatch(/^grafana\/k6:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it("targets T1 and T2 are the spec's", () => {
    expect(config.targets).toEqual({ t1MaxOverheadP95Ms: 15, t2MinSuccessPct: 99 });
  });

  it("rejects an incomplete config with readable problems", () => {
    expect(() => parseBenchConfig({ k6Image: "x" })).toThrow(/mock.latencyMs/);
    const broken = structuredClone(config) as unknown as {
      profiles: { smoke: { scenarios: Record<string, unknown> } };
    };
    delete broken.profiles.smoke.scenarios.chaos;
    expect(() => parseBenchConfig(broken)).toThrow(/profiles.smoke.scenarios.chaos.rate/);
  });

  it("hashes the setup files stably, ignoring line endings, and detects changes", () => {
    const files = readConfigFiles(root);
    expect(files.map((f) => f.path)).toContain("bench/compose.bench.yml");
    const hash = configHash(files);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      configHash(files.map((f) => ({ ...f, content: f.content.replace(/\n/g, "\r\n") }))),
    ).toBe(hash);
    const changed = files.map((f, i) => (i === 0 ? { ...f, content: `${f.content} ` } : f));
    expect(configHash(changed)).not.toBe(hash);
  });
});
