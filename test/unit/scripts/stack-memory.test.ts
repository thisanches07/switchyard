import { describe, expect, it } from "vitest";
import { parseMemUsage, totalMemoryBytes } from "../../../scripts/lib/stack-memory.ts";

describe("stack memory parsing", () => {
  it("parses docker stats MemUsage values", () => {
    expect(parseMemUsage("685MiB / 1.919GiB")).toBe(685 * 1024 ** 2);
    expect(parseMemUsage("1.5GiB / 7.7GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseMemUsage("512KiB / 1GiB")).toBe(512 * 1024);
    expect(parseMemUsage("12.3kB / 1GB")).toBe(12.3 * 1000);
    expect(parseMemUsage("100B / 1GiB")).toBe(100);
  });

  it("rejects unparseable values", () => {
    expect(() => parseMemUsage("--")).toThrow(/cannot parse/);
  });

  it("sums all containers", () => {
    expect(totalMemoryBytes(["1GiB / 2GiB", "512MiB / 2GiB"])).toBe(1.5 * 1024 ** 3);
  });
});
