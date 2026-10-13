import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configSchema } from "../../../src/config/schema.js";
import { formatPath } from "../../../src/config/zod-issues.js";

const examplePath = resolve(import.meta.dirname, "../../../config/switchyard.example.yaml");
const example = (): Record<string, unknown> => parse(readFileSync(examplePath, "utf8"));

function issues(input: unknown) {
  const result = configSchema.safeParse(input);
  if (result.success) throw new Error("expected validation to fail");
  return result.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
}

describe("configSchema", () => {
  it("accepts config/switchyard.example.yaml", () => {
    const result = configSchema.safeParse(example());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("rejects unknown top-level key", () => {
    const found = issues({ ...example(), proviers: {} });
    expect(found[0]?.message).toMatch(/proviers/);
  });

  it("rejects alias with unknown provider", () => {
    const config = example();
    config.aliases = { fast: { strategy: "priority", candidates: ["grok/llama-3"] } };
    const found = issues(config);
    expect(found).toContainEqual({
      path: "aliases.fast.candidates[0]",
      message: expect.stringMatching(/unknown provider "grok" \(known: .*ollama.*\)/),
    });
  });

  it("rejects candidates that are not provider/model", () => {
    const config = example();
    config.aliases = { fast: { strategy: "priority", candidates: ["llama3"] } };
    expect(issues(config)[0]?.path).toBe("aliases.fast.candidates[0]");
  });

  it("rejects baseUrl and baseUrlEnv together", () => {
    const config = example();
    config.providers = {
      ollama: { type: "openai-compatible", baseUrl: "http://x/v1", baseUrlEnv: "OLLAMA_BASE_URL" },
    };
    config.aliases = {};
    config.cache = { exact: { enabled: false, ttlSeconds: 1 } };
    expect(issues(config)[0]?.path).toBe("providers.ollama");
  });

  it("rejects openai-compatible provider without baseUrl or baseUrlEnv", () => {
    const config = example();
    config.providers = { ollama: { type: "openai-compatible" } };
    config.aliases = {};
    config.cache = { exact: { enabled: false, ttlSeconds: 1 } };
    expect(issues(config)[0]?.path).toBe("providers.ollama");
  });

  it("rejects similarityThreshold > 1", () => {
    const config = example();
    const cache = config.cache as { semantic: { similarityThreshold: number } };
    cache.semantic.similarityThreshold = 1.5;
    expect(issues(config)[0]?.path).toBe("cache.semantic.similarityThreshold");
  });

  it("defaults the semantic cache temperature cap and lookup timeout (spec 009, AC-1)", () => {
    const config = configSchema.parse({ providers: { mock: { type: "mock" } } });
    expect(config.cache.semantic).toMatchObject({ maxTemperature: 0.3, lookupTimeoutMs: 300 });
    const custom = configSchema.parse({
      providers: { mock: { type: "mock" } },
      cache: { semantic: { maxTemperature: 0, lookupTimeoutMs: 50 } },
    });
    expect(custom.cache.semantic).toMatchObject({ maxTemperature: 0, lookupTimeoutMs: 50 });
  });

  it.each([
    [{ maxTemperature: -0.1 }, "cache.semantic.maxTemperature"],
    [{ maxTemperature: 2.5 }, "cache.semantic.maxTemperature"],
    [{ lookupTimeoutMs: 0 }, "cache.semantic.lookupTimeoutMs"],
  ])("rejects semantic cache setting %j", (semantic, path) => {
    const found = issues({ providers: { mock: { type: "mock" } }, cache: { semantic } });
    expect(found[0]?.path).toBe(path);
  });

  it("rejects non-positive timeouts", () => {
    const config = example();
    const server = config.server as { timeouts: { ttfbMs: number } };
    server.timeouts.ttfbMs = 0;
    expect(issues(config)[0]?.path).toBe("server.timeouts.ttfbMs");
  });

  it("example config defines the embed alias", () => {
    const config = configSchema.parse(example());
    expect(config.aliases.embed?.candidates).toEqual(["ollama/nomic-embed-text"]);
  });

  it("mock providers accept chunkDelayMs", () => {
    const config = example();
    config.providers = { mock: { type: "mock", chunkDelayMs: 25 } };
    config.aliases = {};
    config.cache = { exact: { enabled: false, ttlSeconds: 1 } };
    const parsed = configSchema.parse(config);
    expect(parsed.providers.mock).toMatchObject({ type: "mock", chunkDelayMs: 25 });
  });

  it("anthropic providers default defaultMaxTokens to 4096 (spec 014)", () => {
    const config = example();
    config.providers = {
      claude: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      other: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", defaultMaxTokens: 1024 },
    };
    config.aliases = {};
    config.cache = { exact: { enabled: false, ttlSeconds: 1 } };
    const parsed = configSchema.parse(config);
    expect(parsed.providers.claude).toMatchObject({ defaultMaxTokens: 4096 });
    expect(parsed.providers.other).toMatchObject({ defaultMaxTokens: 1024 });
  });

  it("example config sets defaultMaxTokens on the claude provider", () => {
    expect(configSchema.parse(example()).providers.claude).toMatchObject({
      type: "anthropic",
      defaultMaxTokens: 4096,
    });
  });
});

describe("limits config (spec 005)", () => {
  const minimal = () => ({ providers: { mock: { type: "mock" } } });

  it("defaults to no key limits and documented settings", () => {
    const config = configSchema.parse(minimal());
    expect(config.limits).toEqual({
      defaults: {},
      completionReserveTokens: 512,
      onRedisError: "open",
      authFailuresPerMinutePerIp: 30,
    });
    expect(config.server.trustProxy).toBe(false);
  });

  it("example config sets default key limits", () => {
    const config = configSchema.parse(example());
    expect(config.limits.defaults).toEqual({ rpm: 60, tpm: 100_000 });
  });

  it.each([
    [{ defaults: { rpm: 0 } }, "limits.defaults.rpm"],
    [{ onRedisError: "maybe" }, "limits.onRedisError"],
    [{ completionReserveTokens: -1 }, "limits.completionReserveTokens"],
    [{ burst: 1 }, "limits"],
  ])("rejects invalid limits %j", (limits, path) => {
    const result = configSchema.safeParse({ ...minimal(), limits });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => formatPath(i.path))).toContain(path);
  });
});

describe("usage config (spec 006)", () => {
  const minimal = () => ({ providers: { mock: { type: "mock" } } });

  it("defaults to publishing on the v1 topic", () => {
    expect(configSchema.parse(minimal()).usage).toEqual({
      enabled: true,
      topic: "usage.events.v1",
      dlqTopic: "usage.events.dlq",
      bufferSize: 10_000,
      flushIntervalMs: 200,
    });
  });

  it("example config documents the usage section", () => {
    expect(configSchema.parse(example()).usage.topic).toBe("usage.events.v1");
  });

  it.each([
    [{ bufferSize: 0 }, "usage.bufferSize"],
    [{ flushIntervalMs: 1.5 }, "usage.flushIntervalMs"],
    [{ topic: "" }, "usage.topic"],
    [{ enabled: "yes" }, "usage.enabled"],
    [{ partitions: 3 }, "usage"],
  ])("rejects invalid usage %j", (usage, path) => {
    const result = configSchema.safeParse({ ...minimal(), usage });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => formatPath(i.path))).toContain(path);
  });
});

describe("pii config (spec 010)", () => {
  const minimal = () => ({ providers: { mock: { type: "mock" } } });

  it("defaults to off, every detector and an empty deny-list", () => {
    const config = configSchema.parse(minimal());
    expect(config.pii).toEqual({
      defaultMode: "off",
      detectors: ["card", "cnpj", "cpf", "email", "ip", "phone", "term"],
      denyList: [],
      streamRestore: { maxHoldMs: 250 },
    });
  });

  it("accepts a mode, a subset of detectors and trimmed deny-list terms", () => {
    const config = configSchema.parse({
      ...minimal(),
      pii: { defaultMode: "mask", detectors: ["cpf", "email"], denyList: ["  Project Falcon "] },
    });
    expect(config.pii).toEqual({
      defaultMode: "mask",
      detectors: ["cpf", "email"],
      denyList: ["Project Falcon"],
      streamRestore: { maxHoldMs: 250 },
    });
  });

  it("accepts stream restore hold limits (spec 015)", () => {
    const config = configSchema.parse({
      ...minimal(),
      pii: { streamRestore: { maxHoldMs: 100, maxHoldChars: 4 } },
    });
    expect(config.pii.streamRestore).toEqual({ maxHoldMs: 100, maxHoldChars: 4 });
  });

  it("example config documents the pii section with mode off", () => {
    expect(configSchema.parse(example()).pii.defaultMode).toBe("off");
    expect(configSchema.parse(example()).pii.streamRestore.maxHoldMs).toBe(250);
  });

  it.each([
    [{ defaultMode: "redact" }, "pii.defaultMode"],
    [{ detectors: ["passport"] }, "pii.detectors[0]"],
    [{ denyList: ["  "] }, "pii.denyList[0]"],
    [{ denyList: "acme" }, "pii.denyList"],
    [{ names: true }, "pii"],
    [{ streamRestore: { maxHoldMs: 0 } }, "pii.streamRestore.maxHoldMs"],
    [{ streamRestore: { maxHoldChars: -1 } }, "pii.streamRestore.maxHoldChars"],
    [{ streamRestore: { maxHoldSeconds: 1 } }, "pii.streamRestore"],
  ])("rejects invalid pii config %j", (pii, path) => {
    const result = configSchema.safeParse({ ...minimal(), pii });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => formatPath(i.path))).toContain(path);
  });
});

describe("budgets config (spec 007)", () => {
  const minimal = () => ({ providers: { mock: { type: "mock" } } });

  it("defaults to fail closed and reconciling every 60 s", () => {
    expect(configSchema.parse(minimal()).budgets).toEqual({
      onRedisError: "closed",
      reconcileIntervalSeconds: 60,
    });
    expect(configSchema.parse(minimal()).pricingFile).toBe("config/pricing.yaml");
  });

  it("example config documents the budgets section", () => {
    expect(configSchema.parse(example()).budgets.onRedisError).toBe("closed");
  });

  it.each([
    [{ onRedisError: "maybe" }, "budgets.onRedisError"],
    [{ reconcileIntervalSeconds: 0 }, "budgets.reconcileIntervalSeconds"],
    [{ reconcileIntervalSeconds: 1.5 }, "budgets.reconcileIntervalSeconds"],
    [{ hard: true }, "budgets"],
  ])("rejects invalid budgets config %j", (budgets, path) => {
    const result = configSchema.safeParse({ ...minimal(), budgets });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => formatPath(i.path))).toContain(path);
  });
});
