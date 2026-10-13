import { describe, expect, it } from "vitest";
import {
  errorFromEvent,
  errorFromStatus,
  markRetryable,
} from "../../../src/modules/anthropic/upstream-errors.js";

const body = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message }, request_id: "req_up" });

describe("errorFromStatus (spec 014, AC-13)", () => {
  it.each([
    [400, "invalid_request_error", 400, "upstream_400", false],
    [403, "permission_error", 403, "upstream_403", false],
    [404, "not_found_error", 404, "upstream_404", false],
    [413, "request_too_large", 413, "upstream_413", false],
    [422, "invalid_request_error", 422, "upstream_422", false],
    [402, "billing_error", 402, "upstream_402", false],
    [401, "authentication_error", 502, "upstream_auth_error", false],
    [429, "rate_limit_error", 429, "upstream_rate_limited", true],
    [529, "overloaded_error", 503, "upstream_overloaded", true],
    [500, "api_error", 502, "upstream_error", true],
    [503, "api_error", 502, "upstream_error", true],
    [504, "timeout_error", 504, "upstream_timeout", true],
  ])("upstream %i %s → %i %s (retryable %s)", (status, type, expected, code, retryable) => {
    const error = errorFromStatus("claude", status, body(type, "upstream says no"));
    expect(error.status).toBe(expected);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  it("passes client errors through with the upstream message and type", () => {
    const error = errorFromStatus("claude", 400, body("invalid_request_error", "max_tokens: bad"));
    expect(error.message).toBe("max_tokens: bad");
    expect(error.type).toBe("invalid_request_error");
  });

  it("never forwards 5xx bodies or the operator's auth failure details", () => {
    expect(errorFromStatus("claude", 500, body("api_error", "secret")).message).not.toContain(
      "secret",
    );
    expect(
      errorFromStatus("claude", 401, body("authentication_error", "invalid x-api-key")).message,
    ).not.toContain("x-api-key");
  });

  it("keeps upstream retry-after on 429", () => {
    const error = errorFromStatus("claude", 429, body("rate_limit_error", "slow"), {
      "retry-after": "12",
    });
    expect(error.headers).toEqual({ "retry-after": "12" });
    expect(errorFromStatus("claude", 429, "").headers).toEqual({});
  });

  it("tolerates non-JSON bodies", () => {
    const error = errorFromStatus("claude", 400, "<html>bad gateway</html>");
    expect(error.status).toBe(400);
    expect(error.code).toBe("upstream_400");
  });
});

describe("errorFromEvent (spec 014, AC-12/AC-13)", () => {
  it.each([
    ["overloaded_error", 503, "upstream_overloaded", true],
    ["api_error", 502, "upstream_error", true],
    ["rate_limit_error", 429, "upstream_rate_limited", true],
    ["timeout_error", 504, "upstream_timeout", true],
    ["invalid_request_error", 400, "upstream_400", false],
    ["something_new", 502, "upstream_error", true],
  ])("event error %s → %i %s", (type, status, code, retryable) => {
    const error = errorFromEvent("claude", { type: "error", error: { type, message: "m" } });
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  it("handles a malformed error event", () => {
    expect(errorFromEvent("claude", "nonsense").status).toBe(502);
  });
});

describe("markRetryable", () => {
  it("copies the error with the flag set", () => {
    const original = errorFromStatus("claude", 400, "");
    const marked = markRetryable(original, true);
    expect(marked).toMatchObject({ status: 400, code: "upstream_400", retryable: true });
    expect(original.retryable).toBe(false);
  });
});
