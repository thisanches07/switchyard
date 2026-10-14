// Raw k6 summaries (handleSummary data) as printed by bench/k6/lib.js between markers.

export const SUMMARY_BEGIN = "<<<BENCH_SUMMARY_BEGIN>>>";
export const SUMMARY_END = "<<<BENCH_SUMMARY_END>>>";

export interface K6Metric {
  type: string;
  contains?: string;
  values: Record<string, number>;
}

export interface K6Summary {
  metrics: Record<string, K6Metric>;
  [key: string]: unknown;
}

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
}

export interface TrendStats extends Percentiles {
  count: number | null;
}

/** The summary JSON between the markers of k6's stdout; throws when absent or malformed. */
export function extractSummary(stdout: string): K6Summary {
  const start = stdout.lastIndexOf(SUMMARY_BEGIN);
  const end = stdout.lastIndexOf(SUMMARY_END);
  if (start < 0 || end < start) throw new Error("k6 output has no benchmark summary");
  const parsed: unknown = JSON.parse(stdout.slice(start + SUMMARY_BEGIN.length, end));
  if (!isSummary(parsed)) throw new Error("k6 summary has no metrics");
  return parsed;
}

export function isSummary(value: unknown): value is K6Summary {
  const metrics = (value as { metrics?: unknown } | null)?.metrics;
  return typeof metrics === "object" && metrics !== null;
}

/** p50/p95/p99 (ms) and sample count of a Trend; null when it has no samples. */
export function trend(summary: K6Summary, name: string): TrendStats | null {
  const values = summary.metrics[name]?.values;
  if (!values) return null;
  const p50 = values["p(50)"] ?? values.med;
  const p95 = values["p(95)"];
  const p99 = values["p(99)"];
  const count = values.count;
  if (p50 === undefined || p95 === undefined || p99 === undefined) return null;
  if (count === 0) return null;
  return { p50, p95, p99, count: count ?? null };
}

/** Total of a Counter; 0 when it was never emitted. */
export function counter(summary: K6Summary, name: string): number {
  return summary.metrics[name]?.values.count ?? 0;
}
