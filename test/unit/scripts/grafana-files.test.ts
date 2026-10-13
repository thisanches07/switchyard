import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkGrafana, dashboardMetrics } from "../../../scripts/lib/grafana-check.ts";
import { buildCatalogue } from "../../../scripts/lib/metric-catalogue.ts";

/** The dashboards, alert rules and provisioning committed under deploy/grafana (spec 011). */
const root = resolve(import.meta.dirname, "../../..");
const grafana = join(root, "deploy", "grafana");
const read = (...parts: string[]) => readFileSync(join(grafana, ...parts), "utf8");
const filesIn = (dir: string, pattern: RegExp) =>
  readdirSync(join(grafana, dir))
    .filter((name) => pattern.test(name))
    .map((name) => ({ path: `${dir}/${name}`, text: read(dir, name) }));

interface Panel {
  type: string;
  title: string;
  panels?: Panel[];
}
const dashboard = (name: string) =>
  JSON.parse(read("dashboards", name)) as { uid: string; title: string; panels: Panel[] };
const titles = (panels: Panel[]): string[] =>
  panels.flatMap((p) => [p.title, ...titles(p.panels ?? [])]);

describe("deploy/grafana (spec 011)", () => {
  it("passes the AC-8 check against the metrics src/ emits", () => {
    const allowlist = JSON.parse(read("metrics-allowlist.json")) as { metrics: string[] };
    const findings = checkGrafana(
      {
        dashboards: filesIn("dashboards", /\.json$/),
        alerts: filesIn("alerting", /\.ya?ml$/),
      },
      {
        catalogue: buildCatalogue(join(root, "src")),
        allowlist: new Set(allowlist.metrics),
      },
    );
    expect(findings).toEqual([]);
  });

  it("Overview answers the AC-6 questions", () => {
    const overview = dashboard("overview.json");
    expect(overview.uid).toBe("switchyard-overview");
    expect(titles(overview.panels)).toEqual(
      expect.arrayContaining([
        "Request rate by status class",
        "Error rate",
        "Request duration",
        "Gateway overhead",
        "Time to first token (TTFB)",
        "Token throughput",
        "Rate-limit rejections",
        "Auth rejections",
        "Usage events dropped",
      ]),
    );
    expect(dashboardMetrics(read("dashboards", "overview.json")).sort()).toEqual([
      "switchyard_auth_failures_total",
      "switchyard_gateway_overhead_seconds_bucket",
      "switchyard_ratelimit_rejections_total",
      "switchyard_request_duration_seconds_bucket",
      "switchyard_request_duration_seconds_count",
      "switchyard_requests_total",
      "switchyard_tokens_total",
      "switchyard_ttfb_seconds_bucket",
      "switchyard_usage_events_dropped_total",
    ]);
  });

  it("ships the four dashboards with unique uids", () => {
    const uids = ["overview", "cost", "providers", "cache"].map(
      (name) => dashboard(`${name}.json`).uid,
    );
    expect(uids).toEqual([
      "switchyard-overview",
      "switchyard-cost",
      "switchyard-providers",
      "switchyard-cache",
    ]);
  });

  it("Cost shows spend by model, team share, unknown costs and budgets", () => {
    expect(titles(dashboard("cost.json").panels)).toEqual(
      expect.arrayContaining([
        "Cost rate by model",
        "Cost by model in range",
        "Requests by team in range",
        "Unknown-cost requests by model",
        "Budget used (top 10)",
        "Budget rejections and soft-limit requests",
      ]),
    );
  });

  it("Providers shows requests, errors, upstream duration and circuit state per provider", () => {
    expect(titles(dashboard("providers.json").panels)).toEqual(
      expect.arrayContaining([
        "Requests by provider",
        "Error ratio by provider",
        "Upstream duration p95 by provider",
        "Attempts by candidate and outcome",
        "Circuit state by candidate",
      ]),
    );
  });

  it("ships the four example alert rules with a summary and a description (AC-7)", () => {
    const files = filesIn("alerting", /\.ya?ml$/);
    const rules = files.flatMap(({ text }) =>
      (
        parse(text) as {
          groups: {
            folder: string;
            rules: { uid: string; annotations: Record<string, string> }[];
          }[];
        }
      ).groups.flatMap((g) => g.rules),
    );
    expect(rules.map((r) => r.uid)).toEqual([
      "switchyard-high-error-rate",
      "switchyard-circuit-open",
      "switchyard-budget-near-limit",
      "switchyard-usage-events-dropped",
    ]);
    for (const rule of rules) {
      expect(rule.annotations.summary, rule.uid).toBeTruthy();
      expect(rule.annotations.description, rule.uid).toMatch(/^Example (threshold|rule)/);
      expect(rule.annotations.description, rule.uid).toMatch(/Check/);
    }
  });

  it("commits no contact point, notification policy or credential", () => {
    for (const { path, text } of filesIn("alerting", /\.ya?ml$/)) {
      const doc = parse(text) as Record<string, unknown>;
      expect(Object.keys(doc).sort(), path).toEqual(["apiVersion", "groups"]);
      expect(text, path).not.toMatch(/contactPoints|policies|password|token:|webhook/i);
    }
  });

  it("the dashboard provider points Grafana at the mounted dashboards folder", () => {
    const provisioning = parse(read("provisioning", "dashboards", "switchyard.yaml")) as {
      providers: { name: string; folder: string; options: { path: string } }[];
    };
    expect(provisioning.providers).toEqual([
      expect.objectContaining({
        name: "Switchyard",
        folder: "Switchyard",
        options: expect.objectContaining({ path: "/otel-lgtm/switchyard/dashboards" }),
      }),
    ]);
  });

  it("docker compose mounts dashboards, provider and alert rules read-only into lgtm", () => {
    const compose = parse(readFileSync(join(root, "docker-compose.yml"), "utf8")) as {
      services: { lgtm: { volumes: string[] } };
    };
    expect(compose.services.lgtm.volumes).toEqual(
      expect.arrayContaining([
        "lgtm-data:/data",
        "./deploy/grafana/provisioning/dashboards/switchyard.yaml:/otel-lgtm/grafana/conf/provisioning/dashboards/switchyard.yaml:ro",
        "./deploy/grafana/dashboards:/otel-lgtm/switchyard/dashboards:ro",
        "./deploy/grafana/alerting:/otel-lgtm/grafana/conf/provisioning/alerting:ro",
      ]),
    );
  });
});
