import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  decimal,
  mulInt,
  normalize,
  round,
  shift,
  sub,
  toFixed,
  tryDecimal,
} from "../../../src/modules/pricing/decimal.js";

describe("exact decimals (spec 007, ADR-0017)", () => {
  it("parses plain decimal strings exactly", () => {
    expect(decimal("0.15")).toEqual({ units: 15n, scale: 2 });
    expect(decimal("10.0000")).toEqual({ units: 100000n, scale: 4 });
    expect(decimal("-2.5")).toEqual({ units: -25n, scale: 1 });
    expect(decimal("7")).toEqual({ units: 7n, scale: 0 });
  });

  it("parses JS numbers from their shortest form, expanding exponents", () => {
    expect(toFixed(decimal(0.15), 2)).toBe("0.15");
    expect(normalize(decimal(1e-7))).toBe("0.0000001");
    expect(normalize(decimal(2.5e-12))).toBe("0.0000000000025");
    expect(normalize(decimal(1.5e21))).toBe("1500000000000000000000");
    expect(normalize(decimal("3E+2"))).toBe("300");
  });

  it("rejects anything that is not a finite decimal", () => {
    for (const bad of ["", "abc", "1.2.3", "1,5", "0x10", " 1", "TODO", ".5", "5."]) {
      expect(tryDecimal(bad)).toBeUndefined();
    }
    expect(tryDecimal(Number.NaN)).toBeUndefined();
    expect(tryDecimal(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(() => decimal("nope")).toThrow(RangeError);
  });

  it("adds, subtracts and multiplies without rounding", () => {
    expect(normalize(add(decimal("0.1"), decimal("0.2")))).toBe("0.3");
    expect(normalize(sub(decimal("10"), decimal("0.0000003")))).toBe("9.9999997");
    expect(normalize(mulInt(decimal("0.15"), 1_000_003))).toBe("150000.45");
    expect(normalize(shift(decimal("150000.45"), 6))).toBe("0.15000045");
  });

  it("compares across scales", () => {
    expect(compare(decimal("1.50"), decimal("1.5"))).toBe(0);
    expect(compare(decimal("1.4999999999"), decimal("1.5"))).toBe(-1);
    expect(compare(decimal("2"), decimal("1.9999"))).toBe(1);
    expect(compare(decimal("-1"), decimal("0"))).toBe(-1);
  });

  it("rounds half-up (away from zero) to a scale", () => {
    expect(toFixed(round(decimal("0.00000000005"), 10), 10)).toBe("0.0000000001");
    expect(toFixed(round(decimal("0.000000000049"), 10), 10)).toBe("0.0000000000");
    expect(toFixed(round(decimal("-0.25"), 1), 1)).toBe("-0.3");
    expect(toFixed(decimal("1.5"), 3)).toBe("1.500");
    expect(toFixed(decimal("2.675"), 2)).toBe("2.68");
  });

  it("normalizes without trailing zeros, exponents or negative zero", () => {
    expect(normalize(decimal("1.500"))).toBe("1.5");
    expect(normalize(decimal("0.000"))).toBe("0");
    expect(normalize(decimal("-0.000"))).toBe("0");
    expect(normalize(decimal("100"))).toBe("100");
    expect(normalize(decimal("0.0000000001"))).toBe("0.0000000001");
  });
});
