/**
 * The Anthropic error surface of `/v1/messages` (spec 014, AC-9/AC-14; ADR-0016). Pure.
 * The route the client called decides the shape; providers never do.
 */
import type { GatewayError } from "../../core/errors.js";

export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string; details: { error_code: string } };
  request_id: string;
}

/** Anthropic's documented `error.type` for an HTTP status. */
export function anthropicErrorType(status: number): string {
  switch (status) {
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 503:
    case 529:
      return "overloaded_error";
    case 504:
      return "timeout_error";
  }
  return status >= 500 ? "api_error" : "invalid_request_error";
}

export function toAnthropicErrorBody(error: GatewayError, requestId: string): AnthropicErrorBody {
  return {
    type: "error",
    error: {
      type: anthropicErrorType(error.status),
      message: error.message,
      // The gateway's own code, where Anthropic reports e.g. enforced_spend_limit_reached.
      details: { error_code: error.code },
    },
    request_id: requestId,
  };
}

/** Inverse of `formatDuration` (`450ms`, `1s`, `6m0s`, `1h2m3s`); undefined if unparseable. */
export function parseDuration(text: string): number | undefined {
  const ms = /^(\d+)ms$/.exec(text);
  if (ms) return Number(ms[1]);
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)$/.exec(text);
  if (!hms) return undefined;
  const [, h = "0", m = "0", s = "0"] = hms;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1_000;
}

/** RFC 3339 at whole-second precision, rounded up so clients never retry too early. */
const rfc3339 = (ms: number) =>
  new Date(Math.ceil(ms / 1_000) * 1_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}` derived from the
 * `x-ratelimit-*` headers the admission already produced (spec 005), for the same buckets.
 */
export function anthropicRateLimitHeaders(
  headers: Readonly<Record<string, unknown>>,
  now: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of ["requests", "tokens"] as const) {
    const limit = headers[`x-ratelimit-limit-${kind}`];
    const remaining = headers[`x-ratelimit-remaining-${kind}`];
    const reset = headers[`x-ratelimit-reset-${kind}`];
    if (limit === undefined || remaining === undefined) continue;
    out[`anthropic-ratelimit-${kind}-limit`] = String(limit);
    out[`anthropic-ratelimit-${kind}-remaining`] = String(remaining);
    const resetMs = typeof reset === "string" ? parseDuration(reset) : undefined;
    if (resetMs !== undefined) out[`anthropic-ratelimit-${kind}-reset`] = rfc3339(now + resetMs);
  }
  return out;
}
