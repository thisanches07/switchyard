import { type Counter, type MeterProvider, metrics, type Span } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import { PII_TYPES, type PiiRequestResult } from "../../core/pii.js";

let instruments: { provider: MeterProvider; detections: Counter } | undefined;

/** Bound to the current global MeterProvider (tests may swap it). */
function detectionsCounter(): Counter {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    instruments = {
      provider,
      detections: provider.getMeter("switchyard").createCounter("switchyard_pii_detections_total", {
        description: "PII occurrences found in scanned requests, by detector type",
      }),
    };
  }
  return instruments.detections;
}

/**
 * Records one scanned request (spec 010, AC-13): the detection counter by type, the request span
 * attributes and a debug log line. Counts and types only, never a value (ADR-0010).
 */
export function recordPiiScan(request: FastifyRequest, result: PiiRequestResult): void {
  const counter = detectionsCounter();
  let total = 0;
  for (const type of PII_TYPES) {
    const count = result.detections[type] ?? 0;
    if (count > 0) counter.add(count, { type });
    total += count;
  }

  // The request span (as in spec 004's tagRequestSpan): handlers run inside their own context.
  const span: Span | null | undefined =
    typeof request.opentelemetry === "function" ? request.opentelemetry().span : undefined;
  span?.setAttributes({
    "switchyard.pii.mode": result.mode,
    "switchyard.pii.action": result.action,
    "switchyard.pii.detections": total,
    ...(result.uninspected && { "switchyard.pii.uninspected": true }),
  });

  request.log.debug(
    { piiMode: result.mode, piiAction: result.action, piiDetections: result.detections },
    "pii scan",
  );
}
