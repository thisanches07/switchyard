import { describe, expect, it } from "vitest";
import { PII_TYPES } from "../../../src/core/pii.js";
import { PATTERN_DETECTORS } from "../../../src/modules/pii/detectors.js";
import { createScanner } from "../../../src/modules/pii/scan.js";

/**
 * Unbounded quantifiers left in a pattern once escapes and character classes are removed:
 * `+`, `*` and `{m,}`. Bounded ones (`{m,n}`, `?`) cannot make a scan super-linear on their own.
 */
function unboundedQuantifiers(source: string): string[] {
  const withoutEscapes = source.replace(/\\./g, "e");
  const withoutClasses = withoutEscapes.replace(/\[[^\]]*\]/g, "c");
  return withoutClasses.match(/[+*]|\{\d+,\}/g) ?? [];
}

describe("PII detection runs in linear time (spec 010, AC-6)", () => {
  it("the checker itself spots unbounded quantifiers", () => {
    expect(unboundedQuantifiers("[a-z]+@")).toEqual(["+"]);
    expect(unboundedQuantifiers("(a|b)*")).toEqual(["*"]);
    expect(unboundedQuantifiers("x{2,}")).toEqual(["{2,}"]);
    expect(unboundedQuantifiers("[+*]{1,3}\\+")).toEqual([]);
  });

  it.each(PATTERN_DETECTORS.map((d, i) => [`${d.type} #${i}`, d.pattern] as const))(
    "pattern %s has only bounded quantifiers and is global",
    (_label, pattern) => {
      expect(unboundedQuantifiers(pattern.source)).toEqual([]);
      expect(pattern.flags).toContain("g");
    },
  );

  const MIB = 1_048_576;
  const fill = (unit: string, size = MIB) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const scan = createScanner({
    types: [...PII_TYPES],
    denyList: ["acme", "aaaa", "project falcon"],
  });

  /**
   * CPU milliseconds of this process for one scan: equal to wall time on an idle CI runner, but
   * not inflated when a shared dev machine is saturated by other work. Best of `runs`.
   */
  function cpuMs(input: string, runs = 1): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i += 1) {
      const started = process.cpuUsage();
      scan(input);
      const { user, system } = process.cpuUsage(started);
      best = Math.min(best, (user + system) / 1000);
    }
    return best;
  }

  it.each([
    ["one long run of digits", fill("1")],
    ["`a@` repeated", fill("a@")],
    ["`1.` repeated", fill("1.")],
    ["`:` repeated", fill(":")],
    ["digits and spaces", fill("1 ")],
    ["digits and hyphens", fill("1-")],
    ["letters", fill("a")],
    ["hex and colons", fill("a:")],
    ["almost e-mails", fill("ana.silva@example")],
    ["almost terms", fill("acm ")],
  ])("scans 1 MiB of %s in under 500 ms", (_label, input) => {
    expect(cpuMs(input)).toBeLessThan(500);
  });

  it("scales linearly when the input is nothing but real values", () => {
    // ~73k detections per MiB: the cost is per detection, so check the growth, not a budget.
    const unit = "529.982.247-25 ana@example.com 192.168.0.1 ";
    const small = Math.max(cpuMs(fill(unit, MIB / 8), 3), 16); // Windows timer: ~16 ms steps
    const large = cpuMs(fill(unit), 2);
    // Linear: about 8x. Quadratic would be about 64x.
    expect(large / small).toBeLessThan(24);
  });
});
