import { GatewayError } from "../../core/errors.js";

export interface RetrySettings {
  /** Attempts in total across all candidates. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Wait before retrying a candidate already tried in this request (spec 008, AC-4): full jitter
 * `random(0, min(maxDelayMs, baseDelayMs × 2^(k−1)))`, where `k` is the attempts made so far,
 * and at least the candidate's `Retry-After` capped at `maxDelayMs`. `random()` is in [0, 1).
 */
export function backoffDelay(
  k: number,
  retry: Pick<RetrySettings, "baseDelayMs" | "maxDelayMs">,
  random: () => number,
  retryAfterMs?: number,
): number {
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.max(0, k - 1));
  const jitter = random() * ceiling;
  const floor = retryAfterMs === undefined ? 0 : Math.min(retryAfterMs, retry.maxDelayMs);
  return Math.round(Math.max(jitter, floor));
}

/** `Retry-After` (delta-seconds or HTTP date) in ms from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);
  if (!/[a-z]/i.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The `Retry-After` an upstream error carried (kept in its headers by the adapters). */
export function retryAfterOf(error: unknown, now: number): number | undefined {
  if (!(error instanceof GatewayError)) return undefined;
  return parseRetryAfter(error.headers["retry-after"], now);
}
