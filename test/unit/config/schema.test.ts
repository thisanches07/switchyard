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
});
