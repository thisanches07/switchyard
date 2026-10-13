import {
  type Counter,
  context,
  type Histogram,
  type MeterProvider,
  metrics,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import type { Principal } from "../../core/auth.js";
import { GatewayError } from "../../core/errors.js";
import type { CacheStatus } from "../../core/usage.js";

interface Instruments {
  provider: MeterProvider;
  requests: Counter;
  upstreamDuration: Histogram;
  ttfb: Histogram;
}
let instruments: Instruments | undefined;

/** Instruments are bound to the current global MeterProvider (tests may swap it). */
function getInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    instruments = {
      provider,
      requests: meter.createCounter("switchyard_requests_total", {
        description: "Requests by provider, resolved model and status returned",
      }),
      upstreamDuration: meter.createHistogram("switchyard_upstream_duration_seconds", {
        description: "Time spent waiting for the provider (whole stream for streaming calls)",
        unit: "s",
      }),
      ttfb: meter.createHistogram("switchyard_ttfb_seconds", {
        description: "Time from the upstream request to the first streamed chunk",
        unit: "s",
      }),
    };
  }
  return instruments;
}

export interface UpstreamCallInfo {
  provider: { name: string; type: string };
  model: string;
  logger: FastifyBaseLogger;
  operation?: "chat" | "embeddings";
  stream?: boolean;
  /** The authenticated caller (spec 004); absent only in low-level tests. */
  principal?: Principal | undefined;
  /** Routing attempt (spec 008): candidate, attempt number and the backoff waited before it. */
  attempt?: { number: number; candidate: string; backoffMs: number } | undefined;
  /** Cache status of the request (spec 009), the `cache` label of requests_total; default bypass. */
  cache?: CacheStatus | undefined;
}

/** Options of a failed attempt (spec 008). */
export interface UpstreamFailOptions {
  /** False when another attempt follows: `switchyard_requests_total` counts client requests. */
  countRequest?: boolean;
}

export interface UpstreamUsage {
  inputTokens: number;
  outputTokens?: number;
}

export interface UpstreamOutcome {
  usage?: UpstreamUsage | undefined;
  responseModel?: string | undefined;
  /** True when usage was estimated because the provider reported none. */
  estimated?: boolean;
}

/** Lifecycle of one upstream call; exactly one terminal method takes effect. */
export interface UpstreamSpan {
  /** Runs `fn` with the span active so HTTP client spans nest under it. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Marks the first streamed chunk (records TTFB); returns TTFB in ms. */
  firstChunk(): number;
  succeed(outcome: UpstreamOutcome): void;
  fail(
    error: unknown,
    phase: "before_first_byte" | "midstream",
    options?: UpstreamFailOptions,
  ): void;
  clientGone(): void;
  /** Adds metadata attributes (never content, ADR-0010). */
  annotate(attributes: Record<string, string | number | boolean>): void;
}

/** Counts one client request against `switchyard_requests_total` (final failed attempt, spec 008). */
export function countUpstreamRequest(info: UpstreamCallInfo, status: string): void {
  getInstruments().requests.add(1, {
    provider: info.provider.name,
    model: info.model,
    status,
    team: info.principal?.teamId ?? "none",
    cache: info.cache ?? "bypass",
  });
}

/** Counts a request served from the response cache (spec 009): no upstream call, status 200. */
export function countCachedRequest(labels: {
  provider: string;
  model: string;
  team: string;
  cache: CacheStatus;
}): void {
  getInstruments().requests.add(1, { ...labels, status: "200" });
}

/**
 * Starts a `switchyard.upstream` span (spec 002 AC-9, spec 003 AC-8).
 * Only metadata is recorded: never message content (ADR-0010).
 */
export function startUpstreamSpan(info: UpstreamCallInfo): UpstreamSpan {
  const { provider, model, logger } = info;
  const operation = info.operation ?? "chat";
  // Looked up per call so a swapped global provider (tests) is always honoured.
  const span: Span = trace.getTracer("switchyard").startSpan("switchyard.upstream", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.operation.name": operation,
      "gen_ai.system": provider.name,
      "gen_ai.request.model": model,
      "switchyard.provider.type": provider.type,
      "switchyard.stream": info.stream ?? false,
      ...(info.principal && {
        "switchyard.team_id": info.principal.teamId,
        "switchyard.key_id": info.principal.keyId,
      }),
      ...(info.attempt && {
        "switchyard.candidate": info.attempt.candidate,
        "switchyard.attempt": info.attempt.number,
        "switchyard.backoff_ms": info.attempt.backoffMs,
      }),
    },
  });
  // Team only on the request counter: durations stay low-cardinality.
  const team = info.principal?.teamId ?? "none";
  const cache = info.cache ?? "bypass";
  const spanContext = trace.setSpan(context.active(), span);
  const started = performance.now();
  const labels = { provider: provider.name, model };
  let ended = false;

  const finish = (status: string, outcome: string, countRequest = true) => {
    ended = true;
    const { requests, upstreamDuration } = getInstruments();
    if (countRequest) requests.add(1, { ...labels, status, team, cache });
    upstreamDuration.record((performance.now() - started) / 1000, { ...labels, outcome });
    span.end();
  };

  return {
    run: (fn) => context.with(spanContext, fn),

    firstChunk() {
      const ttfbMs = performance.now() - started;
      span.setAttribute("switchyard.ttfb_ms", Math.round(ttfbMs));
      getInstruments().ttfb.record(ttfbMs / 1000, labels);
      return ttfbMs;
    },

    succeed(outcome) {
      if (ended) return;
      if (outcome.responseModel) span.setAttribute("gen_ai.response.model", outcome.responseModel);
      if (outcome.usage) {
        span.setAttribute("gen_ai.usage.input_tokens", outcome.usage.inputTokens);
        if (outcome.usage.outputTokens !== undefined) {
          span.setAttribute("gen_ai.usage.output_tokens", outcome.usage.outputTokens);
        }
      }
      if (outcome.estimated) span.setAttribute("switchyard.usage.estimated", true);
      span.setAttribute("http.response.status_code", 200);
      finish("200", "ok");
    },

    fail(error, phase, options = {}) {
      if (ended) return;
      const countRequest = options.countRequest ?? true;
      const status = error instanceof GatewayError ? error.status : 500;
      const code = error instanceof GatewayError ? error.code : "internal_error";
      const outcome = code === "upstream_timeout" ? "timeout" : "error";
      span.setStatus({ code: SpanStatusCode.ERROR, message: code });
      if (phase === "midstream") {
        // Headers (200) were already sent; ADR-0008 forbids retrying from here.
        span.setAttribute("switchyard.midstream_error", true);
        span.setAttribute("http.response.status_code", 200);
        logger.warn({ ...labels, code }, "upstream stream failed after first byte");
        finish("upstream_error_midstream", outcome);
        return;
      }
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) logger.warn({ ...labels, code, status }, "upstream request failed");
      finish(String(status), outcome, countRequest);
    },

    annotate(attributes) {
      if (!ended) span.setAttributes(attributes);
    },

    clientGone() {
      if (ended) return;
      span.setAttribute("switchyard.client_closed", true);
      finish("499", "client_closed");
    },
  };
}

/** Wraps a non-streaming provider call (chat or embeddings) in an upstream span. */
export async function tracedUpstreamCall<T extends UpstreamOutcome>(
  info: UpstreamCallInfo,
  call: () => Promise<T>,
): Promise<T> {
  const upstream = startUpstreamSpan(info);
  try {
    const result = await upstream.run(call);
    upstream.succeed(result);
    return result;
  } catch (error) {
    upstream.fail(error, "before_first_byte");
    throw error;
  }
}
