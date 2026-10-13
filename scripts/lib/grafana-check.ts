/**
 * Checks the Grafana dashboards and alert rules in `deploy/grafana/` (spec 011, AC-8): valid
 * JSON/YAML, unique dashboard uids, only provisioned datasources, and only metric names the code
 * emits (the catalogue) or that are allowlisted. Pure: files and catalogue are passed in.
 */
import { parse as parseYaml } from "yaml";

export interface GrafanaFile {
  path: string;
  text: string;
}

export interface Finding {
  file: string;
  /** `file`, `dashboard`, `panel "<title>"`, `variable "<name>"` or `rule "<uid>"`. */
  location: string;
  message: string;
}

export interface CheckOptions {
  /** Prometheus series names the code emits (`buildCatalogue`). */
  catalogue: ReadonlySet<string>;
  /** Non-Switchyard series dashboards may use (e.g. `up`, `target_info`). */
  allowlist: ReadonlySet<string>;
}

/** Datasource uids `grafana/otel-lgtm` provisions (its `grafana-datasources.yaml`). */
export const PROVISIONED_DATASOURCES = ["prometheus", "tempo", "loki", "pyroscope"] as const;
/** Grafana's server-side expressions (reduce, threshold, math) in alert rules. */
const EXPRESSION_DATASOURCE = "__expr__";

const PROMQL_WORDS = new Set([
  // aggregators
  "sum",
  "min",
  "max",
  "avg",
  "group",
  "stddev",
  "stdvar",
  "count",
  "count_values",
  "bottomk",
  "topk",
  "quantile",
  "limitk",
  "limit_ratio",
  // keywords and binary operators
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  "and",
  "or",
  "unless",
  "atan2",
  "inf",
  "nan",
  // functions
  "abs",
  "absent",
  "absent_over_time",
  "ceil",
  "changes",
  "clamp",
  "clamp_max",
  "clamp_min",
  "day_of_month",
  "day_of_week",
  "day_of_year",
  "days_in_month",
  "delta",
  "deriv",
  "double_exponential_smoothing",
  "exp",
  "floor",
  "histogram_avg",
  "histogram_count",
  "histogram_fraction",
  "histogram_quantile",
  "histogram_stddev",
  "histogram_stdvar",
  "histogram_sum",
  "holt_winters",
  "hour",
  "idelta",
  "increase",
  "info",
  "irate",
  "label_join",
  "label_replace",
  "ln",
  "log2",
  "log10",
  "minute",
  "month",
  "predict_linear",
  "rate",
  "resets",
  "round",
  "scalar",
  "sgn",
  "sort",
  "sort_by_label",
  "sort_by_label_desc",
  "sort_desc",
  "sqrt",
  "time",
  "timestamp",
  "vector",
  "year",
  "avg_over_time",
  "count_over_time",
  "last_over_time",
  "mad_over_time",
  "max_over_time",
  "min_over_time",
  "present_over_time",
  "quantile_over_time",
  "stddev_over_time",
  "stdvar_over_time",
  "sum_over_time",
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "cos",
  "cosh",
  "deg",
  "pi",
  "rad",
  "sin",
  "sinh",
  "tan",
  "tanh",
  // Grafana template functions
  "label_values",
  "label_names",
  "metrics",
  "query_result",
]);

/** Index of the parenthesis closing the one at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** `label_values(metric, label)` → `metric`; `label_values(label)` → nothing. */
function expandLabelValues(expr: string): string {
  let out = expr;
  for (let at = out.search(/label_values\s*\(/); at !== -1; at = out.search(/label_values\s*\(/)) {
    const open = out.indexOf("(", at);
    const close = closingParen(out, open);
    const inner = out.slice(open + 1, close);
    const comma = inner.lastIndexOf(",");
    const metric = comma === -1 ? "" : inner.slice(0, comma);
    out = `${out.slice(0, at)} ${metric} ${out.slice(close + 1)}`;
  }
  return out;
}

/** Metric names referenced by a PromQL expression (in order, without duplicates). */
export function metricNames(expr: string): string[] {
  const stripped = expandLabelValues(
    expr
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, " ")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/\[[^\]]*\]/g, " "),
  )
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ")
    .replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, " ");
  const names: string[] = [];
  for (const match of stripped.matchAll(/(?<![\w.:])[A-Za-z_:][\w:]*/g)) {
    const word = match[0];
    if (PROMQL_WORDS.has(word.toLowerCase()) || names.includes(word)) continue;
    names.push(word);
  }
  return names;
}

interface Query {
  location: string;
  exprs: string[];
  datasources: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const uidOf = (datasource: unknown): string | undefined =>
  isRecord(datasource) && typeof datasource.uid === "string" ? datasource.uid : undefined;

function panelQueries(panels: unknown[], into: Query[]): Query[] {
  for (const panel of panels) {
    if (!isRecord(panel)) continue;
    const targets = asArray(panel.targets).filter(isRecord);
    const datasources = [uidOf(panel.datasource), ...targets.map((t) => uidOf(t.datasource))];
    into.push({
      location: `panel "${String(panel.title ?? panel.id ?? "?")}"`,
      exprs: targets.map((t) => t.expr).filter((e): e is string => typeof e === "string"),
      datasources: datasources.filter((d): d is string => d !== undefined),
    });
    panelQueries(asArray(panel.panels), into);
  }
  return into;
}

function dashboardQueries(dashboard: Record<string, unknown>): Query[] {
  const queries = panelQueries(asArray(dashboard.panels), []);
  const templating = isRecord(dashboard.templating) ? asArray(dashboard.templating.list) : [];
  for (const variable of templating.filter(isRecord)) {
    if (variable.type !== "query") continue;
    const query = isRecord(variable.query) ? variable.query.query : variable.query;
    const uid = uidOf(variable.datasource);
    queries.push({
      location: `variable "${String(variable.name)}"`,
      exprs: typeof query === "string" ? [query] : [],
      datasources: uid === undefined ? [] : [uid],
    });
  }
  return queries;
}

function ruleQueries(doc: unknown): Query[] {
  const queries: Query[] = [];
  const groups = isRecord(doc) ? asArray(doc.groups) : [];
  for (const group of groups.filter(isRecord)) {
    for (const rule of asArray(group.rules).filter(isRecord)) {
      const data = asArray(rule.data).filter(isRecord);
      queries.push({
        location: `rule "${String(rule.uid ?? rule.title ?? "?")}"`,
        exprs: data
          .map((d) => (isRecord(d.model) ? d.model.expr : undefined))
          .filter((e): e is string => typeof e === "string"),
        datasources: data
          .map((d) => d.datasourceUid)
          .filter((d): d is string => typeof d === "string"),
      });
    }
  }
  return queries;
}

function checkQueries(
  file: string,
  queries: Query[],
  allowedDatasources: ReadonlySet<string>,
  options: CheckOptions,
  findings: Finding[],
): void {
  for (const query of queries) {
    for (const uid of new Set(query.datasources)) {
      if (!allowedDatasources.has(uid)) {
        findings.push({
          file,
          location: query.location,
          message: `unknown datasource uid "${uid}"`,
        });
      }
    }
    const names = new Set(query.exprs.flatMap(metricNames));
    for (const name of names) {
      if (!options.catalogue.has(name) && !options.allowlist.has(name)) {
        findings.push({ file, location: query.location, message: `unknown metric "${name}"` });
      }
    }
  }
}

/** Every metric a dashboard's panels and variables query (the AC-9 smoke step checks them). */
export function dashboardMetrics(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return [];
  const names = dashboardQueries(parsed).flatMap((q) => q.exprs.flatMap(metricNames));
  return [...new Set(names)];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function checkGrafana(
  files: { dashboards: GrafanaFile[]; alerts: GrafanaFile[] },
  options: CheckOptions,
): Finding[] {
  const findings: Finding[] = [];
  const dashboardSources = new Set<string>(PROVISIONED_DATASOURCES);
  const ruleSources = new Set<string>([...PROVISIONED_DATASOURCES, EXPRESSION_DATASOURCE]);
  const uids = new Map<string, string>();

  for (const { path, text } of files.dashboards) {
    let dashboard: unknown;
    try {
      dashboard = JSON.parse(text);
    } catch (error) {
      findings.push({ file: path, location: "file", message: `invalid JSON: ${errorText(error)}` });
      continue;
    }
    if (!isRecord(dashboard)) {
      findings.push({ file: path, location: "file", message: "not a dashboard object" });
      continue;
    }
    const uid = dashboard.uid;
    if (typeof uid !== "string" || uid === "") {
      findings.push({ file: path, location: "dashboard", message: "missing uid" });
    } else if (uids.has(uid)) {
      findings.push({
        file: path,
        location: "dashboard",
        message: `uid "${uid}" also used by ${uids.get(uid)}`,
      });
    } else {
      uids.set(uid, path);
    }
    checkQueries(path, dashboardQueries(dashboard), dashboardSources, options, findings);
  }

  for (const { path, text } of files.alerts) {
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (error) {
      findings.push({ file: path, location: "file", message: `invalid YAML: ${errorText(error)}` });
      continue;
    }
    checkQueries(path, ruleQueries(doc), ruleSources, options, findings);
  }
  return findings;
}
