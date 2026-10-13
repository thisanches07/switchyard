import { describe, expect, it } from "vitest";
import { loadEnv } from "../../../src/config/env.js";
import { ConfigError } from "../../../src/config/errors.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  KEY_PEPPER: "test-pepper-0123456789abcdefghijklmnop",
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

describe("loadEnv: auth settings (spec 004)", () => {
  const pepper = "p".repeat(32);

  it("requires KEY_PEPPER of at least 32 characters", () => {
    const { KEY_PEPPER: _omit, ...withoutPepper } = { ...base, KEY_PEPPER: pepper };
    expect(issuesOf(() => loadEnv(withoutPepper)).map((i) => i.path)).toContain("KEY_PEPPER");
    expect(issuesOf(() => loadEnv({ ...base, KEY_PEPPER: "short" })).map((i) => i.path)).toContain(
      "KEY_PEPPER",
    );
  });

  it("accepts an optional ADMIN_TOKEN of at least 16 characters", () => {
    expect(loadEnv({ ...base, KEY_PEPPER: pepper }).ADMIN_TOKEN).toBeUndefined();
    expect(loadEnv({ ...base, KEY_PEPPER: pepper, ADMIN_TOKEN: "a".repeat(16) }).ADMIN_TOKEN).toBe(
      "a".repeat(16),
    );
    expect(
      issuesOf(() => loadEnv({ ...base, KEY_PEPPER: pepper, ADMIN_TOKEN: "tiny" })).map(
        (i) => i.path,
      ),
    ).toContain("ADMIN_TOKEN");
  });

  it("parses MIGRATE_ON_BOOT with a false default", () => {
    expect(loadEnv({ ...base, KEY_PEPPER: pepper }).MIGRATE_ON_BOOT).toBe(false);
    expect(loadEnv({ ...base, KEY_PEPPER: pepper, MIGRATE_ON_BOOT: "true" }).MIGRATE_ON_BOOT).toBe(
      true,
    );
    expect(
      issuesOf(() => loadEnv({ ...base, KEY_PEPPER: pepper, MIGRATE_ON_BOOT: "yes" })).map(
        (i) => i.path,
      ),
    ).toContain("MIGRATE_ON_BOOT");
  });
});
