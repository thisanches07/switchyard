import { describe, expect, it } from "vitest";
import { loadEnv } from "../../../src/config/env.js";
import { findDevSecrets } from "../../../src/config/secrets.js";

const real = {
  ADMIN_TOKEN: "3f9a1c0e5b7d2a4c6e8f0a1b3c5d7e9f",
  KEY_PEPPER: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
  DATABASE_URL: "postgres://switchyard:Zq7v1x9w2y8u3t4s@postgres:5432/switchyard",
};

describe("findDevSecrets (spec 013, AC-4)", () => {
  it("accepts real values", () => {
    expect(findDevSecrets(real)).toEqual([]);
  });

  it("lists the dev-only admin token, pepper and database password without echoing them", () => {
    const issues = findDevSecrets({
      ADMIN_TOKEN: "dev-only-admin-token-change-me",
      KEY_PEPPER: "dev-only-pepper-change-me-0123456789abcdef",
      DATABASE_URL: "postgres://switchyard:switchyard@postgres:5432/switchyard",
    });
    expect(issues.map((i) => i.path)).toEqual(["ADMIN_TOKEN", "KEY_PEPPER", "DATABASE_URL"]);
    expect(JSON.stringify(issues)).not.toContain("dev-only-admin-token-change-me");
  });

  it("rejects the replace-me placeholders of the production env example", () => {
    const issues = findDevSecrets({
      ADMIN_TOKEN: "replace-me-with-openssl-rand-hex-32",
      KEY_PEPPER: "replace-me-with-openssl-rand-hex-32",
      DATABASE_URL: "postgres://switchyard:replace-me-with-openssl-rand-hex-24@postgres:5432/db",
    });
    expect(issues.map((i) => i.path)).toEqual(["ADMIN_TOKEN", "KEY_PEPPER", "DATABASE_URL"]);
  });

  it("requires an admin token", () => {
    expect(findDevSecrets({ ...real, ADMIN_TOKEN: undefined })).toEqual([
      { path: "ADMIN_TOKEN", message: "is required when SWITCHYARD_REQUIRE_SECRETS=true" },
    ]);
  });

  it("decodes the database password before comparing", () => {
    const url = "postgres://switchyard:%73witchyard@postgres:5432/switchyard";
    expect(findDevSecrets({ ...real, DATABASE_URL: url }).map((i) => i.path)).toEqual([
      "DATABASE_URL",
    ]);
  });
});

describe("SWITCHYARD_REQUIRE_SECRETS", () => {
  const base = {
    DATABASE_URL: real.DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    KEY_PEPPER: real.KEY_PEPPER,
  };

  it("defaults to false", () => {
    expect(loadEnv(base).SWITCHYARD_REQUIRE_SECRETS).toBe(false);
  });

  it('is true only for "true"', () => {
    expect(
      loadEnv({ ...base, SWITCHYARD_REQUIRE_SECRETS: "true" }).SWITCHYARD_REQUIRE_SECRETS,
    ).toBe(true);
    expect(() => loadEnv({ ...base, SWITCHYARD_REQUIRE_SECRETS: "yes" })).toThrow(
      /SWITCHYARD_REQUIRE_SECRETS/,
    );
  });
});
