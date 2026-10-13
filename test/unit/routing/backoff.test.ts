import { describe, expect, it } from "vitest";
import { GatewayError, upstreamError, upstreamRateLimited } from "../../../src/core/errors.js";
import {
  backoffDelay,
  parseRetryAfter,
  retryAfterOf,
} from "../../../src/modules/routing/backoff.js";

const retry = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000 };
const fixed = (value: number) => () => value;

describe("backoffDelay (spec 008, AC-4)", () => {
  it.each([
    [1, 100],
    [2, 200],
    [3, 400],
    [4, 800],
    [5, 1_000],
    [9, 1_000],
  ])("after %i attempts the ceiling is %i ms", (k, ceiling) => {
    // random() is in [0, 1): just below 1 gives the ceiling, 0 gives no wait.
    expect(backoffDelay(k, retry, fixed(0.999_999))).toBe(ceiling);
    expect(backoffDelay(k, retry, fixed(0))).toBe(0);
  });

  it("is full jitter: a uniform share of the ceiling", () => {
    expect(backoffDelay(3, retry, fixed(0.25))).toBe(100);
    expect(backoffDelay(3, retry, fixed(0.5))).toBe(200);
  });

  it("waits at least Retry-After, capped at maxDelayMs", () => {
    expect(backoffDelay(1, retry, fixed(0), 700)).toBe(700);
    expect(backoffDelay(1, retry, fixed(0), 5_000)).toBe(1_000);
    // A jitter above the Retry-After floor wins.
    expect(backoffDelay(4, retry, fixed(0.5), 100)).toBe(400);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("3", now)).toBe(3_000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(" 1.5 ", now)).toBe(1_500);
  });

  it("reads an HTTP date relative to now, never negative", () => {
    expect(parseRetryAfter("Tue, 13 Oct 2026 12:00:04 GMT", now)).toBe(4_000);
    expect(parseRetryAfter("Tue, 13 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });

  it.each([undefined, "", "soon", "-3"])("ignores %s", (value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

describe("retryAfterOf", () => {
  it("reads the retry-after header a provider error carries", () => {
    expect(retryAfterOf(upstreamRateLimited("p", { "retry-after": "2" }), 0)).toBe(2_000);
  });

  it("is undefined without the header or for other errors", () => {
    expect(retryAfterOf(upstreamError("p"), 0)).toBeUndefined();
    expect(retryAfterOf(new Error("x"), 0)).toBeUndefined();
    expect(
      retryAfterOf(new GatewayError(503, "server_error", "c", "m", { "retry-after": "x" }), 0),
    ).toBeUndefined();
  });
});
