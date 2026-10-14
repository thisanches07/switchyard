import {
  type Counter,
  type Histogram,
  type MeterProvider,
  metrics,
  type Span,
} from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import { PII_TYPES, type PiiRequestResult } from "../../core/pii.js";
import type { HoldListener } from "./stream-restore.js";

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

const HOLD_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

let streamInstruments: { provider: MeterProvider; hold: Histogram; failures: Counter } | undefined;

function streamRestoreInstruments() {
  const provider = metrics.getMeterProvider();
  if (streamInstruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    streamInstruments = {
      provider,
      hold: meter.createHistogram("switchyard_pii_stream_hold_seconds", {
        description: "Time streamed text was held back while it could still be a PII placeholder",
        unit: "s",
        // Holds are bounded by pii.streamRestore.maxHoldMs (250 ms by default): the SDK's default
        // buckets are millisecond-sized and would put every sample in the first one.
        advice: { explicitBucketBoundaries: HOLD_BUCKETS },
      }),
      failures: meter.createCounter("switchyard_pii_stream_restore_failures_total", {
        description: "Held stream fragments released unrestored, by reason",
      }),
    };
  }
  return streamInstruments;
}

/**
 * Hold listener of one streamed request (spec 015, AC-5): the hold histogram, the failure counter
 * (`reason="hold_limit"`) and running counts through `annotate` (the serving attempt's upstream
 * span: the request span has already ended once a stream's body flows). Durations and counts
 * only, never the held text (ADR-0010).
 */
export function streamHoldRecorder(annotate?: SpanAnnotator): HoldListener {
  let holds = 0;
  let failures = 0;
  return ({ heldMs, outcome }) => {
    const instruments = streamRestoreInstruments();
    instruments.hold.record(heldMs / 1000);
    holds += 1;
    annotate?.({ "switchyard.pii.stream_holds": holds });
    if (outcome === "hold_limit") {
      instruments.failures.add(1, { reason: outcome });
      failures += 1;
      annotate?.({ "switchyard.pii.stream_restore_failures": failures });
    }
  };
}

/** Sets metadata attributes on a span (never content). */
export type SpanAnnotator = (attributes: Record<string, number>) => void;
