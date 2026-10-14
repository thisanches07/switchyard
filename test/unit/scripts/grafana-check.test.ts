import { describe, expect, it } from "vitest";
import {
  type CheckOptions,
  checkGrafana,
  type GrafanaFile,
  metricNames,
} from "../../../scripts/lib/grafana-check.ts";

const options: CheckOptions = {
  catalogue: new Set([
    "switchyard_requests_total",
    "switchyard_ttfb_seconds_bucket",
    "switchyard_circuit_state",
  ]),
  allowlist: new Set(["up"]),
};

const panel = (title: string, expr: string, uid = "prometheus") => ({
  title,
  type: "timeseries",
  datasource: { type: "prometheus", uid },
  targets: [{ refId: "A", datasource: { type: "prometheus", uid }, expr }],
});

const dashboard = (uid: string, panels: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ uid, title: uid, panels, ...extra });

const file = (path: string, text: string): GrafanaFile => ({ path, text });

const rules = (expr: string, uid = "prometheus") => `
apiVersion: 1
groups:
  - orgId: 1
    name: switchyard
    folder: Switchyard
    interval: 1m
    rules:
      - uid: rule-1
        title: Rule one
        condition: C
        data:
          - refId: A
            datasourceUid: ${uid}
            model:
              expr: '${expr}'
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
`;

describe("PromQL metric names (spec 011, AC-8)", () => {
  it("ignores functions, aggregators, labels, ranges, groupings and variables", () => {
    expect(
      metricNames(
        'histogram_quantile(0.95, sum by (le, provider) (rate(switchyard_ttfb_seconds_bucket{provider=~"$provider", status!="200"}[$__rate_interval])))',
      ),
    ).toEqual(["switchyard_ttfb_seconds_bucket"]);
  });

  it("finds every metric of a binary expression", () => {
    expect(
      metricNames(
        "sum(rate(a_total[5m])) / clamp_min(sum without (team) (rate(b_total[5m] offset 1h)), 1e-9) > bool 0.5 and on(job) up",
      ),
    ).toEqual(["a_total", "b_total", "up"]);
  });

  it("reads the metric of label_values() but not its label", () => {
    expect(metricNames("label_values(switchyard_requests_total, team)")).toEqual([
      "switchyard_requests_total",
    ]);
    expect(metricNames("label_values(team)")).toEqual([]);
  });
});

describe("checkGrafana", () => {
  it("accepts dashboards and rules that only use catalogue metrics and known datasources", () => {
    const findings = checkGrafana(
      {
        dashboards: [
          file("overview.json", dashboard("a", [panel("Rate", "sum(rate(up[1m]))")])),
          file(
            "providers.json",
            dashboard("b", [
              { type: "row", title: "Row", panels: [panel("Circuit", "switchyard_circuit_state")] },
              { type: "text", title: "Notes", options: { content: "no queries" } },
            ]),
          ),
        ],
        alerts: [file("alerts.yaml", rules("max(switchyard_circuit_state)"))],
      },
      options,
    );
    expect(findings).toEqual([]);
  });

  it("names the file, the panel and the unknown metric", () => {
    const findings = checkGrafana(
      {
        dashboards: [
          file(
            "overview.json",
            dashboard("a", [panel("Errors", "sum(rate(switchyard_typo[5m]))")]),
          ),
        ],
        alerts: [],
      },
      options,
    );
    expect(findings).toEqual([
      {
        file: "overview.json",
        location: 'panel "Errors"',
        message: 'unknown metric "switchyard_typo"',
      },
    ]);
  });

  it("checks panels nested in rows and templating queries", () => {
    const findings = checkGrafana(
      {
        dashboards: [
          file(
            "d.json",
            dashboard(
              "a",
              [{ type: "row", title: "R", panels: [panel("Inner", "nested_total")] }],
              {
                templating: {
                  list: [
                    { name: "team", type: "query", query: "label_values(missing_total, team)" },
                  ],
                },
              },
            ),
          ),
        ],
        alerts: [],
      },
      options,
    );
    expect(findings.map((f) => `${f.location}: ${f.message}`)).toEqual([
      'panel "Inner": unknown metric "nested_total"',
      'variable "team": unknown metric "missing_total"',
    ]);
  });

  it("reports invalid JSON and YAML", () => {
    const findings = checkGrafana(
      { dashboards: [file("bad.json", "{ nope")], alerts: [file("bad.yaml", "a: [unclosed")] },
      options,
    );
    expect(findings.map((f) => [f.file, f.location])).toEqual([
      ["bad.json", "file"],
      ["bad.yaml", "file"],
    ]);
    expect(findings[0]?.message).toMatch(/invalid JSON/);
    expect(findings[1]?.message).toMatch(/invalid YAML/);
  });

  it("reports duplicate and missing dashboard uids", () => {
    const findings = checkGrafana(
      {
        dashboards: [
          file("one.json", dashboard("same", [])),
          file("two.json", dashboard("same", [])),
          file("three.json", JSON.stringify({ title: "no uid", panels: [] })),
        ],
        alerts: [],
      },
      options,
    );
    expect(findings).toEqual([
      { file: "two.json", location: "dashboard", message: 'uid "same" also used by one.json' },
      { file: "three.json", location: "dashboard", message: "missing uid" },
    ]);
  });

  it("reports datasources other than the provisioned ones", () => {
    const findings = checkGrafana(
      {
        dashboards: [file("d.json", dashboard("a", [panel("P", "up", "my-prom")]))],
        alerts: [file("a.yaml", rules("up", "other"))],
      },
      options,
    );
    expect(findings).toEqual([
      { file: "d.json", location: 'panel "P"', message: 'unknown datasource uid "my-prom"' },
      { file: "a.yaml", location: 'rule "rule-1"', message: 'unknown datasource uid "other"' },
    ]);
  });

  it("checks the metrics of alert rule queries", () => {
    const findings = checkGrafana(
      { dashboards: [], alerts: [file("a.yaml", rules("sum(rate(gone_total[5m])) > 0"))] },
      options,
    );
    expect(findings).toEqual([
      { file: "a.yaml", location: 'rule "rule-1"', message: 'unknown metric "gone_total"' },
    ]);
  });
});
