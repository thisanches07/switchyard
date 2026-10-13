import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import { normalizeDecimal, parseUsageQuery, todayUtc } from "../../../src/modules/usage/report.js";

const TODAY = "2026-10-13";
const TEAM = "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";

function rejects(raw: unknown): string {
  try {
    parseUsageQuery(raw, TODAY);
  } catch (error) {
    if (error instanceof GatewayError) {
      expect(error.status).toBe(400);
      expect(error.code).toBe("invalid_request");
      return error.message;
    }
    throw error;
  }
  throw new Error("expected a 400");
}

describe("GET /admin/usage query (spec 006, AC-11)", () => {
  it("defaults to the last 30 days grouped by day", () => {
    expect(parseUsageQuery({}, TODAY)).toEqual({
      from: "2026-09-14",
      to: "2026-10-13",
      groupBy: "day",
    });
  });

  it("defaults from to 29 days before an explicit to", () => {
    expect(parseUsageQuery({ to: "2026-03-01" }, TODAY)).toMatchObject({
      from: "2026-01-31",
      to: "2026-03-01",
    });
  });

  it("accepts every groupBy and the optional filters", () => {
    for (const groupBy of ["team", "key", "model", "provider", "day"]) {
      expect(parseUsageQuery({ groupBy }, TODAY).groupBy).toBe(groupBy);
    }
    expect(
      parseUsageQuery({ from: "2026-10-01", to: "2026-10-01", teamId: TEAM, keyId: TEAM }, TODAY),
    ).toEqual({ from: "2026-10-01", to: "2026-10-01", groupBy: "day", teamId: TEAM, keyId: TEAM });
  });

  it("accepts a range of exactly 366 days", () => {
    expect(parseUsageQuery({ from: "2025-10-12", to: "2026-10-13" }, TODAY).from).toBe(
      "2025-10-12",
    );
  });

  it.each([
    [{ from: "2026-13-01" }, "from"],
    [{ to: "2026-02-30" }, "to"],
    [{ from: "13/10/2026" }, "from"],
    [{ teamId: "team-1" }, "teamId"],
    [{ keyId: "x" }, "keyId"],
    [{ groupBy: "week" }, "groupBy"],
    [{ from: "2026-10-02", to: "2026-10-01" }, "from"],
    [{ from: "2025-10-11", to: "2026-10-13" }, "366"],
  ])("rejects %j", (raw, mention) => {
    expect(rejects(raw)).toContain(mention);
  });
});

describe("normalizeDecimal", () => {
  it.each([
    ["0", "0"],
    ["0.0000000000", "0"],
    ["1.500", "1.5"],
    ["12", "12"],
    ["0.0000123400", "0.00001234"],
    ["100.000", "100"],
  ])("%s → %s", (input, output) => {
    expect(normalizeDecimal(input)).toBe(output);
  });
});

describe("todayUtc", () => {
  it("formats the UTC date", () => {
    expect(todayUtc(Date.parse("2026-10-13T23:59:59Z"))).toBe("2026-10-13");
    expect(todayUtc(Date.parse("2026-10-14T00:00:00Z"))).toBe("2026-10-14");
  });
});
