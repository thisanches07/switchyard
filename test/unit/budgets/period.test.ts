import { describe, expect, it } from "vitest";
import { counterExpiry, periodOf } from "../../../src/modules/budgets/period.js";

const at = (iso: string) => Date.parse(iso);

describe("budget periods: calendar months in UTC (spec 007, AC-5)", () => {
  it("covers the month containing the instant", () => {
    expect(periodOf(at("2026-10-13T12:34:56.789Z"))).toEqual({
      id: "2026-10",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
      startDay: "2026-10-01",
      endDay: "2026-11-01",
      startMs: at("2026-10-01T00:00:00.000Z"),
      endMs: at("2026-11-01T00:00:00.000Z"),
    });
  });

  it("starts a new period at 00:00:00Z on the first day", () => {
    expect(periodOf(at("2026-10-31T23:59:59.999Z")).id).toBe("2026-10");
    expect(periodOf(at("2026-11-01T00:00:00.000Z")).id).toBe("2026-11");
  });

  it("is UTC regardless of the offset an instant is written with", () => {
    expect(periodOf(at("2026-11-01T01:30:00+02:00")).id).toBe("2026-10");
  });

  it("rolls over the year in December", () => {
    const december = periodOf(at("2026-12-31T23:00:00Z"));
    expect(december.id).toBe("2026-12");
    expect(december.end).toBe("2027-01-01T00:00:00.000Z");
  });

  it("handles February in leap and common years", () => {
    expect(periodOf(at("2028-02-29T10:00:00Z")).end).toBe("2028-03-01T00:00:00.000Z");
    expect(periodOf(at("2027-02-28T10:00:00Z")).endDay).toBe("2027-03-01");
  });

  it("keeps counters for 7 days after the period ends, then they expire", () => {
    const period = periodOf(at("2026-10-13T00:00:00Z"));
    expect(counterExpiry(period)).toBe(at("2026-11-08T00:00:00.000Z"));
  });
});
