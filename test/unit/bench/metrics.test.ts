import { describe, expect, it } from "vitest";
import {
  collectServerOverhead,
  type Fetch,
  overheadQueries,
  vectorValue,
} from "../../../bench/lib/metrics.ts";

const vector = (value: string | null) => ({
  status: "success",
  data: { resultType: "vector", result: value === null ? [] : [{ metric: {}, value: [1, value] }] },
});

describe("server-side overhead queries (AC-7)", () => {
  it("builds histogram_quantile and count queries over the window with the selector", () => {
    const q = overheadQueries("switchyard_gateway_overhead_seconds", 'job="gw"', 154.2);
    expect(q.quantiles.p95).toBe(
      'histogram_quantile(0.95, sum by (le) (increase(switchyard_gateway_overhead_seconds_bucket{job="gw"}[155s])))',
    );
    expect(q.count).toBe(
      'sum(increase(switchyard_gateway_overhead_seconds_count{job="gw"}[155s]))',
    );
  });

  it("reads an instant vector value, null when empty or NaN", () => {
    expect(vectorValue(vector("0.0042"))).toBe(0.0042);
    expect(vectorValue(vector(null))).toBeNull();
    expect(vectorValue(vector("NaN"))).toBeNull();
    expect(vectorValue({ status: "error" })).toBeNull();
  });
});

describe("collectServerOverhead (AC-7)", () => {
  const base = {
    prometheusUrl: "http://prom:9090",
    metric: "switchyard_gateway_overhead_seconds",
    selector: 'job="switchyard-gateway"',
    windowStart: new Date("2026-10-13T10:00:00Z"),
    evaluateAt: new Date("2026-10-13T10:02:35Z"),
  };

  it("converts seconds to milliseconds and queries at the evaluation time", async () => {
    const urls: string[] = [];
    const values: Record<string, string> = { "0.5": "0.002", "0.95": "0.004", "0.99": "0.009" };
    const fetch: Fetch = async (url) => {
      urls.push(url);
      const query = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
      const q = /histogram_quantile\(([\d.]+)/.exec(query)?.[1];
      return { ok: true, status: 200, json: async () => vector(q ? (values[q] ?? null) : "6000") };
    };
    const result = await collectServerOverhead({ ...base, fetch });
    expect(result).toMatchObject({ p50: 2, p95: 4, p99: 9, count: 6000, reason: null });
    expect(urls[0]).toContain(`time=${base.evaluateAt.getTime() / 1000}.000`);
    expect(decodeURIComponent(urls[0] ?? "")).toContain("[155s]");
  });

  it("reports a missing metric as null with a reason, never as zero", async () => {
    const fetch: Fetch = async () => ({ ok: true, status: 200, json: async () => vector(null) });
    expect(await collectServerOverhead({ ...base, fetch })).toMatchObject({
      p50: null,
      p95: null,
      p99: null,
      count: null,
      reason: "metric not exported (no series in the window)",
    });
  });

  it("reports an unreachable Prometheus", async () => {
    const fetch: Fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await collectServerOverhead({ ...base, fetch });
    expect(result.reason).toBe("Prometheus unreachable: ECONNREFUSED");
    expect(result.queries).toHaveLength(4);
  });
});
