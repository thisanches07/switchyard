/**
 * Cache metrics, warnings and request-span attributes (spec 009, AC-9, AC-12, AC-13). Labels and
 * attributes are metadata only: never keys, hashes, embeddings or content (ADR-0010).
 */
import { type Counter, type MeterProvider, metrics, type Span } from "@opentelemetry/api";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { CacheStatus } from "../../core/usage.js";

export type CacheLayer = "exact" | "semantic";
export type LookupResult = "hit" | "miss" | "error";
export type CacheStage = "lookup" | "write";

interface Instruments {
  provider: MeterProvider;
  lookups: Counter;
  errors: Counter;
  savings: Counter;
  savingsUnknown: Counter;
}
let instruments: Instruments | undefined;

/** Bound to the current global MeterProvider (tests may swap it). */
function getInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    instruments = {
      provider,
      lookups: meter.createCounter("switchyard_cache_lookups_total", {
        description: "Cache lookups by layer (exact, semantic) and result (hit, miss, error)",
      }),
      errors: meter.createCounter("switchyard_cache_errors_total", {
        description: "Cache failures by layer and stage (lookup, write); the layer was skipped",
      }),
      savings: meter.createCounter("switchyard_cache_savings_usd_total", {
        description: "USD the stored usage of cache hits would have cost at current prices",
        unit: "{USD}",
      }),
      savingsUnknown: meter.createCounter("switchyard_cache_savings_unknown_total", {
        description: "Cache hits whose price is unknown (not counted in the savings)",
      }),
    };
  }
  return instruments;
}

export function countLookup(layer: CacheLayer, result: LookupResult): void {
  getInstruments().lookups.add(1, { layer, result });
}

export function countCacheError(layer: CacheLayer, stage: CacheStage): void {
  getInstruments().errors.add(1, { layer, stage });
}

/** Adds a hit's saving; an unknown price (undefined) adds nothing and is counted apart (AC-9). */
export function recordSavings(
  layer: CacheLayer,
  labels: { model: string; team: string },
  usd: number | undefined,
): void {
  const { savings, savingsUnknown } = getInstruments();
  if (usd === undefined || !Number.isFinite(usd)) {
    savingsUnknown.add(1, { layer, ...labels });
    return;
  }
  savings.add(usd, { layer, ...labels });
}

/** Logs a cache warning at most once per `intervalMs` per layer (AC-12), on an injected clock. */
export function createWarnLimiter(now: () => number, intervalMs = 60_000) {
  const last = new Map<CacheLayer, number>();
  return (
    logger: Pick<FastifyBaseLogger, "warn">,
    layer: CacheLayer,
    stage: CacheStage,
    error: unknown,
  ): void => {
    const at = now();
    const previous = last.get(layer);
    if (previous !== undefined && at - previous < intervalMs) return;
    last.set(layer, at);
    // The error message only: never the key, the embedding or the cached content.
    logger.warn(
      { layer, stage, err: error instanceof Error ? error.message : String(error) },
      "cache layer skipped",
    );
  };
}

/** `switchyard.cache.*` attributes on the request span (`@fastify/otel`'s request context). */
export function tagCacheSpan(
  request: FastifyRequest,
  attributes: { result: CacheStatus; layer?: CacheLayer; similarity?: number },
): void {
  const span: Span | null | undefined =
    typeof request.opentelemetry === "function" ? request.opentelemetry().span : undefined;
  span?.setAttributes({
    "switchyard.cache.result": attributes.result,
    ...(attributes.layer && { "switchyard.cache.layer": attributes.layer }),
    ...(attributes.similarity !== undefined && {
      "switchyard.cache.similarity": Math.round(attributes.similarity * 10_000) / 10_000,
    }),
  });
}
