/**
 * The emitted metric catalogue (spec 011, AC-8): every instrument registered under `src/`, named
 * as Prometheus in `grafana/otel-lgtm` exposes it. Prometheus's OTLP receiver uses the
 * `UnderscoreEscapingWithSuffixes` strategy by default; this is a port of the parts of
 * `prometheus/otlptranslator` (`normalizeName`) that apply to our instruments.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type InstrumentKind = "counter" | "histogram" | "gauge";

export interface Instrument {
  name: string;
  kind: InstrumentKind;
  unit?: string;
}

/** OTel API factory → Prometheus metric type (non-monotonic sums become gauges). */
const FACTORIES: Record<string, InstrumentKind> = {
  createCounter: "counter",
  createObservableCounter: "counter",
  createHistogram: "histogram",
  createUpDownCounter: "gauge",
  createObservableUpDownCounter: "gauge",
  createGauge: "gauge",
  createObservableGauge: "gauge",
};

const UNIT_MAP: Record<string, string> = {
  d: "days",
  h: "hours",
  min: "minutes",
  s: "seconds",
  ms: "milliseconds",
  us: "microseconds",
  ns: "nanoseconds",
  By: "bytes",
  KiBy: "kibibytes",
  MiBy: "mebibytes",
  GiBy: "gibibytes",
  TiBy: "tebibytes",
  kBy: "kilobytes",
  KBy: "kilobytes",
  MBy: "megabytes",
  GBy: "gigabytes",
  TBy: "terabytes",
  m: "meters",
  V: "volts",
  A: "amperes",
  J: "joules",
  W: "watts",
  g: "grams",
  Cel: "celsius",
  Hz: "hertz",
  "1": "",
  "%": "percent",
};

const PER_UNIT_MAP: Record<string, string> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  mo: "month",
  y: "year",
};

const cleanUpUnit = (unit: string) =>
  unit
    .replace(/[^a-zA-Z0-9:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_/, "");

function unitSuffixes(unit: string): { main: string; per: string } {
  const [mainRaw = "", perRaw] = unit.split(/\/(.*)/s, 2);
  let main = "";
  let per = "";
  const mainUnit = mainRaw.trim();
  if (mainUnit !== "" && !/[{}]/.test(mainUnit)) main = UNIT_MAP[mainUnit] ?? mainUnit;
  const perUnit = perRaw?.trim() ?? "";
  if (perUnit !== "" && !/[{}]/.test(perUnit)) per = `per_${PER_UNIT_MAP[perUnit] ?? perUnit}`;
  return { main: cleanUpUnit(main), per: cleanUpUnit(per) };
}

/** The Prometheus series names one instrument produces. */
export function prometheusNames(instrument: Instrument): string[] {
  let tokens = instrument.name.split(/[^a-zA-Z0-9:]+/).filter(Boolean);
  const unit = instrument.unit ?? "";
  let { main, per } = unitSuffixes(unit);
  if (tokens.includes(main)) main = "";
  if (per === "per_") per = "";
  else {
    per = per.replace(/_$/, "");
    if (tokens.includes(per)) per = "";
  }
  if (per !== "") main = main.replace(/_$/, "");
  if (main !== "") tokens.push(main);
  if (per !== "") tokens.push(per);
  if (instrument.kind === "counter") tokens = [...tokens.filter((t) => t !== "total"), "total"];
  if (unit === "1" && instrument.kind === "gauge") {
    tokens = [...tokens.filter((t) => t !== "ratio"), "ratio"];
  }
  let name = tokens.join("_");
  if (/^\d/.test(name)) name = `_${name}`;
  if (instrument.kind === "histogram") return [`${name}_bucket`, `${name}_sum`, `${name}_count`];
  return [name];
}

/** The options object literal starting at `start` (a `{`), by brace matching. */
function objectAt(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** Instruments registered in one source file (`meter.createX("name", { unit })`). */
export function extractInstruments(source: string): Instrument[] {
  const found: Instrument[] = [];
  const pattern = /\.(create[A-Za-z]+)\(\s*"([^"]+)"\s*(,\s*\{)?/g;
  for (const match of source.matchAll(pattern)) {
    const kind = FACTORIES[match[1] as string];
    if (!kind) continue;
    const instrument: Instrument = { name: match[2] as string, kind };
    if (match[3]) {
      const options = objectAt(source, (match.index ?? 0) + match[0].length - 1);
      const unit = options.match(/\bunit:\s*"([^"]*)"/)?.[1];
      if (unit !== undefined) instrument.unit = unit;
    }
    found.push(instrument);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(dir, file));
}

/** Every Prometheus series name the code under `srcDir` emits. */
export function buildCatalogue(srcDir: string): Set<string> {
  const catalogue = new Set<string>();
  for (const file of sourceFiles(srcDir)) {
    for (const instrument of extractInstruments(readFileSync(file, "utf8"))) {
      for (const name of prometheusNames(instrument)) catalogue.add(name);
    }
  }
  return catalogue;
}
