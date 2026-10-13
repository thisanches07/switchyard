import { describe, expect, it } from "vitest";
import { GatewayError, modelNotFound, rateLimited } from "../../../src/core/errors.js";
import {
  anthropicErrorType,
  anthropicRateLimitHeaders,
  parseDuration,
  toAnthropicErrorBody,
} from "../../../src/modules/anthropic/inbound-errors.js";

describe("anthropicErrorType (spec 014, AC-14)", () => {
  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [409, "invalid_request_error"],
    [413, "request_too_large"],
    [415, "invalid_request_error"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [502, "api_error"],
    [503, "overloaded_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
  ])("%i → %s", (status, type) => {
    expect(anthropicErrorType(status)).toBe(type);
  });
});

describe("toAnthropicErrorBody (AC-14)", () => {
  it("uses the Anthropic shape with the gateway code in details.error_code", () => {
    expect(toAnthropicErrorBody(modelNotFound("gpt-9"), "req_1")).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: 'The model "gpt-9" does not exist',
        details: { error_code: "model_not_found" },
      },
      request_id: "req_1",
    });
  });

  it("chooses the type by status, not by the OpenAI type", () => {
    const error = new GatewayError(503, "server_error", "upstream_overloaded", "busy");
    expect(toAnthropicErrorBody(error, "r").error.type).toBe("overloaded_error");
  });
});

describe("parseDuration", () => {
  it.each([
    ["450ms", 450],
    ["1s", 1_000],
    ["6m0s", 360_000],
    ["1h2m3s", 3_723_000],
    ["bogus", undefined],
    ["", undefined],
  ])("%s → %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });
});

describe("anthropicRateLimitHeaders (AC-9)", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");

  it("derives anthropic-ratelimit-* from x-ratelimit-* with RFC 3339 resets", () => {
    expect(
      anthropicRateLimitHeaders(
        {
          "x-ratelimit-limit-requests": "60",
          "x-ratelimit-remaining-requests": "59",
          "x-ratelimit-reset-requests": "1s",
          "x-ratelimit-limit-tokens": "100000",
          "x-ratelimit-remaining-tokens": "99000",
          "x-ratelimit-reset-tokens": "450ms",
          "retry-after": "3",
        },
        now,
      ),
    ).toEqual({
      "anthropic-ratelimit-requests-limit": "60",
      "anthropic-ratelimit-requests-remaining": "59",
      "anthropic-ratelimit-requests-reset": "2026-10-13T12:00:01Z",
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "99000",
      "anthropic-ratelimit-tokens-reset": "2026-10-13T12:00:01Z",
    });
  });

  it("returns nothing for unlimited kinds", () => {
    expect(anthropicRateLimitHeaders({}, now)).toEqual({});
  });

  it("works on the headers of a gateway 429", () => {
    const error = rateLimited("requests", "key", 1, {
      "x-ratelimit-limit-requests": "1",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "1m0s",
      "retry-after": "60",
    });
    expect(anthropicRateLimitHeaders(error.headers, now)).toEqual({
      "anthropic-ratelimit-requests-limit": "1",
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "2026-10-13T12:01:00Z",
    });
  });
});
