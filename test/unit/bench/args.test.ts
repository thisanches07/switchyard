import { describe, expect, it } from "vitest";
import { parseArgs } from "../../../bench/lib/args.ts";
import { SCENARIOS } from "../../../bench/lib/config.ts";

describe("pnpm bench arguments (AC-2)", () => {
  it("runs every scenario of the full profile by default", () => {
    expect(parseArgs([])).toEqual({ scenarios: [...SCENARIOS], smoke: false, keep: false });
  });

  it("accepts --smoke, --keep and the separator pnpm may forward", () => {
    expect(parseArgs(["--", "--smoke", "--keep"])).toMatchObject({ smoke: true, keep: true });
  });

  it("selects scenarios by name, comma list or repetition, in canonical order", () => {
    expect(parseArgs(["--scenario", "chaos"]).scenarios).toEqual(["chaos"]);
    expect(parseArgs(["--scenario=chaos,no-cache"]).scenarios).toEqual(["no-cache", "chaos"]);
    expect(parseArgs(["--scenario", "streaming", "--scenario", "streaming"]).scenarios).toEqual([
      "streaming",
    ]);
  });

  it("rejects unknown scenarios and arguments with the usage", () => {
    expect(() => parseArgs(["--scenario", "fast"])).toThrow(/unknown scenario "fast"[\s\S]*usage/);
    expect(() => parseArgs(["--scenario"])).toThrow(/needs a name/);
    expect(() => parseArgs(["--fast"])).toThrow(/unknown argument/);
  });
});
