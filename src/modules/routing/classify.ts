import { GatewayError } from "../../core/errors.js";

/** How an attempt failed before any response data reached the client (spec 008). */
export type FailureClass = "retryable" | "non_retryable" | "timeout";

/** Upstream statuses worth another attempt: request timeout, rate limit, server errors. */
export const isRetryableStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/**
 * Classifies a failed attempt (spec 008, AC-3; ADR-0004). Adapters may set an explicit
 * `retryable` flag (spec 014: a rejected operator key is a 502 that must not be retried);
 * otherwise the status decides. Anything that is not a `GatewayError` is a gateway bug: not retried.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (!(error instanceof GatewayError)) return "non_retryable";
  const retryable = error.retryable ?? isRetryableStatus(error.status);
  if (!retryable) return "non_retryable";
  return error.code === "upstream_timeout" ? "timeout" : "retryable";
}
