import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  extractInstruments,
  prometheusNames,
} from "../../../scripts/lib/metric-catalogue.ts";

const root = resolve(import.meta.dirname, "../../..");

describe("OTLP to Prometheus metric names (spec 011, AC-8)", () => {
  it("keeps a counter that already ends in _total", () => {
    expect(prometheusNames({ name: "switchyard_requests_total", kind: "counter" })).toEqual([
      "switchyard_requests_total",
    ]);
  });

  it("appends _total to a counter without it", () => {
    expect(prometheusNames({ name: "http.requests", kind: "counter" })).toEqual([
      "http_requests_total",
    ]);
  });

  it("expands histograms and does not repeat a unit already in the name", () => {
    expect(
      prometheusNames({ name: "switchyard_ttfb_seconds", kind: "histogram", unit: "s" }),
    ).toEqual([
      "switchyard_ttfb_seconds_bucket",
      "switchyard_ttfb_seconds_sum",
      "switchyard_ttfb_seconds_count",
    ]);
  });

  it("appends the Prometheus unit word when missing", () => {
    expect(prometheusNames({ name: "db.duration", kind: "histogram", unit: "ms" })).toContain(
      "db_duration_milliseconds_count",
    );
    expect(prometheusNames({ name: "rx", kind: "counter", unit: "By/s" })).toEqual([
      "rx_bytes_per_second_total",
    ]);
  });

  it("ignores units in braces", () => {
    expect(
      prometheusNames({ name: "switchyard_cost_usd_total", kind: "counter", unit: "{USD}" }),
    ).toEqual(["switchyard_cost_usd_total"]);
  });

  it("appends a non-UCUM unit case-sensitively, as Prometheus does", () => {
    expect(
      prometheusNames({ name: "switchyard_cost_usd_total", kind: "counter", unit: "USD" }),
    ).toEqual(["switchyard_cost_usd_USD_total"]);
  });

  it("names gauges as is, and adds _ratio for unit 1", () => {
    expect(prometheusNames({ name: "switchyard_circuit_state", kind: "gauge" })).toEqual([
      "switchyard_circuit_state",
    ]);
    expect(prometheusNames({ name: "cpu.utilization", kind: "gauge", unit: "1" })).toEqual([
      "cpu_utilization_ratio",
    ]);
  });
});

describe("instrument extraction", () => {
  it("finds every kind of instrument with its unit", () => {
    const source = `
      meter.createCounter("a_total", { description: "x" });
      meter.createHistogram("b_seconds", {
        description: "y",
        unit: "s",
        advice: { explicitBucketBoundaries: [0.1, 1] },
      });
      meter
        .createObservableGauge("c_events", { description: "z" })
        .addCallback(() => {});
      meter.createUpDownCounter("d");
      meter.createGauge("e", { unit: "1" });
    `;
    expect(extractInstruments(source)).toEqual([
      { name: "a_total", kind: "counter" },
      { name: "b_seconds", kind: "histogram", unit: "s" },
      { name: "c_events", kind: "gauge" },
      { name: "d", kind: "gauge" },
      { name: "e", kind: "gauge", unit: "1" },
    ]);
  });
});

describe("catalogue of src/", () => {
  it("contains the fixed metric names Grafana queries", () => {
    const catalogue = buildCatalogue(resolve(root, "src"));
    for (const name of [
      "switchyard_requests_total",
      "switchyard_ttfb_seconds_bucket",
      "switchyard_upstream_duration_seconds_count",
      "switchyard_cost_usd_total",
      "switchyard_budget_used_ratio",
      "switchyard_circuit_state",
      "switchyard_usage_events_dropped_total",
      "switchyard_ratelimit_rejections_total",
    ]) {
      expect(catalogue.has(name), name).toBe(true);
    }
  });
});
