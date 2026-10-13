import { describe, expect, it } from "vitest";
import {
  formatDuration,
  rateLimitHeaders,
  retryAfterSeconds,
} from "../../../src/modules/ratelimit/headers.js";

describe("rate limit headers", () => {
  it.each([
    [0, "0ms"],
    [450, "450ms"],
    [999.2, "1000ms"],
    [1_000, "1s"],
    [1_001, "2s"],
    [59_500, "1m0s"],
    [360_000, "6m0s"],
    [3_723_000, "1h2m3s"],
  ])("formatDuration(%d) = %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("reports the most restrictive bucket per kind", () => {
    const headers = rateLimitHeaders([
      { kind: "requests", capacity: 60, remaining: 59, resetMs: 1_000 },
      { kind: "requests", capacity: 1_000, remaining: 3.7, resetMs: 60_000 },
      { kind: "tokens", capacity: 100_000, remaining: 99_000, resetMs: 600 },
    ]);
    expect(headers).toEqual({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "3",
      "x-ratelimit-reset-requests": "1m0s",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "99000",
      "x-ratelimit-reset-tokens": "600ms",
    });
  });

  it("never reports negative remaining and omits unlimited kinds", () => {
    const headers = rateLimitHeaders([
      { kind: "tokens", capacity: 1_000, remaining: -250, resetMs: 75_000 },
    ]);
    expect(headers).toEqual({
      "x-ratelimit-limit-tokens": "1000",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "1m15s",
    });
    expect(rateLimitHeaders([])).toEqual({});
  });

  it("retry-after is whole seconds and at least 1", () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(10)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
  });
});
