/**
 * `switchyard_tokens_total{direction,provider,model}` (spec 011, AC-3). A recorder in the same
 * fan-out as the usage publisher, so the counter sees exactly the usage events and its totals
 * match `inputTokens`/`outputTokens` of the events for the same requests.
 */
import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api";
import type { OutcomeRecorder } from "../../core/usage.js";

let instruments: { provider: MeterProvider; tokens: Counter } | undefined;

/** Bound to the current global MeterProvider (tests may swap it). */
function tokensCounter(): Counter {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    instruments = {
      provider,
      tokens: provider.getMeter("switchyard").createCounter("switchyard_tokens_total", {
        description: "Tokens of completed requests by direction, provider and served model",
        unit: "{token}",
      }),
    };
  }
  return instruments.tokens;
}

export const tokenMetricsRecorder: OutcomeRecorder = {
  record(event) {
    const labels = { provider: event.provider ?? "none", model: event.servedModel ?? "none" };
    const counter = tokensCounter();
    if (event.inputTokens > 0) counter.add(event.inputTokens, { direction: "input", ...labels });
    if (event.outputTokens > 0) counter.add(event.outputTokens, { direction: "output", ...labels });
  },
};
