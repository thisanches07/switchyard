// Checks deploy/grafana dashboards and alert rules against the metrics the code emits
// (spec 011, AC-8). Runs in `pnpm verify`: `node scripts/check-grafana.ts`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkGrafana, type GrafanaFile } from "./lib/grafana-check.ts";
import { buildCatalogue } from "./lib/metric-catalogue.ts";

const root = resolve(import.meta.dirname, "..");
const grafana = join(root, "deploy", "grafana");

function filesIn(dir: string, pattern: RegExp): GrafanaFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { path: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") };
    });
}

const allowlist = JSON.parse(readFileSync(join(grafana, "metrics-allowlist.json"), "utf8")) as {
  metrics: string[];
};
const dashboards = filesIn(join(grafana, "dashboards"), /\.json$/);
const alerts = filesIn(join(grafana, "alerting"), /\.ya?ml$/);
const findings = checkGrafana(
  { dashboards, alerts },
  { catalogue: buildCatalogue(join(root, "src")), allowlist: new Set(allowlist.metrics) },
);

if (findings.length > 0) {
  for (const f of findings) console.error(`✗ ${f.file} › ${f.location}: ${f.message}`);
  console.error(`\n${findings.length} problem(s) in deploy/grafana (spec 011, AC-8).`);
  process.exit(1);
}
console.log(`✓ deploy/grafana: ${dashboards.length} dashboard(s), ${alerts.length} alert file(s)`);
