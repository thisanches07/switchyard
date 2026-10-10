import {
  type Counter,
  type Histogram,
  type MeterProvider,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import { GatewayError } from "../../core/errors.js";
import type { ChatProvider, ChatResult } from "../../core/provider.js";

const tracer = trace.getTracer("switchyard");

interface Instruments {
  provider: MeterProvider;
  requests: Counter;
  upstreamDuration: Histogram;
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
        description: "Chat requests by provider, resolved model and HTTP status returned",
      }),
      upstreamDuration: meter.createHistogram("switchyard_upstream_duration_seconds", {
        description: "Time spent waiting for the provider",
        unit: "s",
      }),
    };
  }
  return instruments;
}

export interface UpstreamCallInfo {
  provider: ChatProvider;
  model: string;
  logger: FastifyBaseLogger;
}

/**
 * Wraps a provider call in a `switchyard.upstream` span and records metrics (spec 002, AC-9).
 * Only metadata is recorded: never message content (ADR-0010).
 */
export function tracedUpstreamCall(
  info: UpstreamCallInfo,
  call: () => Promise<ChatResult>,
): Promise<ChatResult> {
  const { provider, model, logger } = info;
  return tracer.startActiveSpan(
    "switchyard.upstream",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": provider.name,
        "gen_ai.request.model": model,
        "switchyard.provider.type": provider.type,
      },
    },
    async (span) => {
      const started = performance.now();
      const labels = { provider: provider.name, model };
      try {
        const result = await call();
        if (result.responseModel) span.setAttribute("gen_ai.response.model", result.responseModel);
        if (result.usage) {
          span.setAttribute("gen_ai.usage.input_tokens", result.usage.inputTokens);
          span.setAttribute("gen_ai.usage.output_tokens", result.usage.outputTokens);
        }
        span.setAttribute("http.response.status_code", 200);
        record(labels, 200, "ok", started);
        return result;
      } catch (error) {
        const status = error instanceof GatewayError ? error.status : 500;
        const code = error instanceof GatewayError ? error.code : "internal_error";
        span.setStatus({ code: SpanStatusCode.ERROR, message: code });
        span.setAttribute("http.response.status_code", status);
        record(labels, status, code === "upstream_timeout" ? "timeout" : "error", started);
        if (status >= 500) {
          logger.warn({ ...labels, code, status }, "upstream request failed");
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

function record(
  labels: { provider: string; model: string },
  status: number,
  outcome: "ok" | "error" | "timeout",
  started: number,
): void {
  const { requests, upstreamDuration } = getInstruments();
  requests.add(1, { ...labels, status: String(status) });
  upstreamDuration.record((performance.now() - started) / 1000, { ...labels, outcome });
}
