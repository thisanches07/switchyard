// Server-side gateway overhead (spec 012, AC-7) from spec 011's histogram, read from the
// Prometheus inside grafana/otel-lgtm after a scenario. A missing series is reported as such,
// never as zero.
import type { ServerOverhead } from "./types.ts";

const QUANTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;

export interface OverheadQueries {
  quantiles: Record<keyof typeof QUANTILES, string>;
  count: string;
}

export function overheadQueries(
  metric: string,
  selector: string,
  rangeSeconds: number,
): OverheadQueries {
  const range = `${Math.max(1, Math.ceil(rangeSeconds))}s`;
  const quantile = (q: number) =>
    `histogram_quantile(${q}, sum by (le) (increase(${metric}_bucket{${selector}}[${range}])))`;
  return {
    quantiles: {
      p50: quantile(QUANTILES.p50),
      p95: quantile(QUANTILES.p95),
      p99: quantile(QUANTILES.p99),
    },
    count: `sum(increase(${metric}_count{${selector}}[${range}]))`,
  };
}

/** The single value of an instant-vector response; null when empty or not a number. */
export function vectorValue(response: unknown): number | null {
  const data = (response as { status?: unknown; data?: { result?: unknown } } | null) ?? {};
  if (data.status !== "success" || !Array.isArray(data.data?.result)) return null;
  const first = data.data.result[0] as { value?: unknown } | undefined;
  const raw = Array.isArray(first?.value) ? first.value[1] : undefined;
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

export type Fetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CollectInput {
  prometheusUrl: string;
  metric: string;
  selector: string;
  /** Start of the steady phase. */
  windowStart: Date;
  /** Evaluation time: end of the steady phase plus the export lag. */
  evaluateAt: Date;
  fetch?: Fetch;
}

export async function collectServerOverhead(input: CollectInput): Promise<ServerOverhead> {
  const doFetch: Fetch = input.fetch ?? ((url) => fetch(url));
  const rangeSeconds = (input.evaluateAt.getTime() - input.windowStart.getTime()) / 1000;
  const queries = overheadQueries(input.metric, input.selector, rangeSeconds);
  const time = (input.evaluateAt.getTime() / 1000).toFixed(3);
  const run = async (query: string) => {
    const url = `${input.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}&time=${time}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`Prometheus answered ${res.status}`);
    return vectorValue(await res.json());
  };
  const all = [queries.quantiles.p50, queries.quantiles.p95, queries.quantiles.p99, queries.count];
  try {
    const [p50, p95, p99, count] = await Promise.all(all.map(run));
    const ms = (seconds: number | null | undefined) =>
      seconds === null || seconds === undefined ? null : seconds * 1000;
    const missing = p50 == null && p95 == null && p99 == null;
    return {
      p50: ms(p50),
      p95: ms(p95),
      p99: ms(p99),
      count: count ?? null,
      reason: missing ? "metric not exported (no series in the window)" : null,
      queries: all,
    };
  } catch (error) {
    return {
      p50: null,
      p95: null,
      p99: null,
      count: null,
      reason: `Prometheus unreachable: ${error instanceof Error ? error.message : String(error)}`,
      queries: all,
    };
  }
}
