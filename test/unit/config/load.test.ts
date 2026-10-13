import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/config/errors.js";
import { loadConfig, loadUsageConfig, loadWorkerConfig } from "../../../src/config/load.js";

const root = resolve(import.meta.dirname, "../../..");
const example = resolve(root, "config/switchyard.example.yaml");
const fixture = (name: string) => resolve(root, "test/fixtures/config", name);
const env = { OLLAMA_BASE_URL: "http://host.docker.internal:11434/v1" };

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("loads example config", () => {
    const config = loadConfig(example, env);
    expect(Object.keys(config.providers)).toEqual(
      expect.arrayContaining(["ollama", "groq", "claude", "mock"]),
    );
    expect(config.aliases.local?.candidates).toEqual(["ollama/llama3.2"]);
  });

  it("resolves baseUrlEnv to host Ollama URL", () => {
    const config = loadConfig(example, env);
    expect(config.providers.ollama).toEqual({
      type: "openai-compatible",
      baseUrl: "http://host.docker.internal:11434/v1",
    });
  });

  it("fails when baseUrlEnv variable is unset", () => {
    const error = configError(() => loadConfig(example, {}));
    expect(error.issues).toContainEqual({
      path: "providers.ollama.baseUrlEnv",
      message: "environment variable OLLAMA_BASE_URL is not set",
    });
  });

  it("fails when baseUrlEnv variable is not a URL", () => {
    const error = configError(() => loadConfig(example, { OLLAMA_BASE_URL: "nope" }));
    expect(error.issues[0]?.path).toBe("providers.ollama.baseUrlEnv");
  });

  it("reports YAML syntax error with position", () => {
    const error = configError(() => loadConfig(fixture("invalid-syntax.yaml"), env));
    expect(error.source).toBe(fixture("invalid-syntax.yaml"));
    expect(error.issues[0]?.message).toMatch(/line \d+, column \d+/);
  });

  it("reports schema errors with the file as source", () => {
    const error = configError(() => loadConfig(fixture("unknown-provider.yaml"), env));
    expect(error.message).toContain(`Invalid configuration in ${fixture("unknown-provider.yaml")}`);
    expect(error.message).toContain('aliases.fast.candidates[0]: unknown provider "grok"');
  });

  it("reports missing file", () => {
    const error = configError(() => loadConfig(fixture("does-not-exist.yaml"), env));
    expect(error.issues[0]?.message).toMatch(/file not found/);
  });
});

describe("loadWorkerConfig (spec 007)", () => {
  it("reads the usage and budgets sections only", () => {
    expect(loadWorkerConfig(example)).toEqual({
      usage: expect.objectContaining({ topic: "usage.events.v1" }),
      budgets: { onRedisError: "closed", reconcileIntervalSeconds: 60 },
    });
  });

  it("reports an invalid budgets section with its path", () => {
    const error = configError(() => loadWorkerConfig(fixture("invalid-budgets.yaml")));
    expect(error.issues).toContainEqual(
      expect.objectContaining({ path: "budgets.reconcileIntervalSeconds" }),
    );
  });
});

describe("loadUsageConfig (spec 006)", () => {
  it("reads only the usage section, without provider environment variables", () => {
    expect(loadUsageConfig(example)).toMatchObject({
      enabled: true,
      topic: "usage.events.v1",
      dlqTopic: "usage.events.dlq",
    });
  });

  it("reports an invalid usage section with its path", () => {
    const error = configError(() => loadUsageConfig(fixture("invalid-usage.yaml")));
    expect(error.issues).toContainEqual(expect.objectContaining({ path: "usage.bufferSize" }));
  });

  it("reports YAML syntax errors and missing files", () => {
    expect(
      configError(() => loadUsageConfig(fixture("invalid-syntax.yaml"))).issues[0]?.message,
    ).toMatch(/YAML syntax error/);
    expect(
      configError(() => loadUsageConfig(fixture("does-not-exist.yaml"))).issues[0]?.message,
    ).toMatch(/file not found/);
  });
});
