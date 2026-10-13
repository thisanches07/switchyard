import { describe, expect, it } from "vitest";
import { loadEnv } from "../../../src/config/env.js";
import { ConfigError } from "../../../src/config/errors.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected ConfigError");
}

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      PORT: 8080,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      SWITCHYARD_CONFIG: "config/switchyard.yaml",
      OTEL_SERVICE_NAME: "switchyard-gateway",
      SHUTDOWN_TIMEOUT_MS: 9000,
    });
  });

  it("rejects missing DATABASE_URL", () => {
    const issues = issuesOf(() => loadEnv({ REDIS_URL: base.REDIS_URL }));
    expect(issues.map((i) => i.path)).toContain("DATABASE_URL");
  });

  it("rejects a DATABASE_URL that is not a postgres URL", () => {
    const issues = issuesOf(() => loadEnv({ ...base, DATABASE_URL: "mysql://x" }));
    expect(issues.map((i) => i.path)).toContain("DATABASE_URL");
  });

  it("rejects invalid PORT", () => {
    const issues = issuesOf(() => loadEnv({ ...base, PORT: "99999" }));
    expect(issues.map((i) => i.path)).toContain("PORT");
  });

  it("rejects SHUTDOWN_TIMEOUT_MS >= 10000", () => {
    const issues = issuesOf(() => loadEnv({ ...base, SHUTDOWN_TIMEOUT_MS: "10000" }));
    expect(issues.map((i) => i.path)).toContain("SHUTDOWN_TIMEOUT_MS");
  });

  it("reports the environment as the error source", () => {
    expect(() => loadEnv({})).toThrowError(/Invalid configuration in environment/);
  });
});
