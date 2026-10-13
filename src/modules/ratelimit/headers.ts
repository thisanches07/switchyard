import type { LimitKind } from "./plan.js";

export interface HeaderBucket {
  kind: LimitKind;
  capacity: number;
  remaining: number;
  resetMs: number;
}

/** OpenAI-style durations: `450ms`, `1s`, `6m0s`, `1h2m3s` (sub-second values round up to ms). */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.ceil(ms)}ms`;
  const total = Math.ceil(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** `retry-after` in whole seconds, at least 1 (spec 005, AC-7). */
export const retryAfterSeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1_000));

/**
 * `x-ratelimit-*` headers for the most restrictive bucket of each kind (spec 005, AC-7).
 * Kinds without a bucket (unlimited) produce no headers.
 */
export function rateLimitHeaders(buckets: readonly HeaderBucket[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const kind of ["requests", "tokens"] as const) {
    const tightest = buckets
      .filter((b) => b.kind === kind)
      .reduce<HeaderBucket | undefined>(
        (best, b) => (best === undefined || b.remaining < best.remaining ? b : best),
        undefined,
      );
    if (!tightest) continue;
    headers[`x-ratelimit-limit-${kind}`] = String(tightest.capacity);
    headers[`x-ratelimit-remaining-${kind}`] = String(Math.max(0, Math.floor(tightest.remaining)));
    headers[`x-ratelimit-reset-${kind}`] = formatDuration(tightest.resetMs);
  }
  return headers;
}
