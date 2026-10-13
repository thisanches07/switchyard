import { isSpanContextValid, trace } from "@opentelemetry/api";

export interface TraceContext {
  trace_id?: string;
  span_id?: string;
}

/** Ids of the active span, for correlating log lines with traces. Empty outside a span. */
export function getTraceContext(): TraceContext {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
