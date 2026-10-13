import { type Counter, type Gauge, type MeterProvider, metrics } from "@opentelemetry/api";
import type { BreakerState } from "./breaker.js";

/** Outcome of one upstream attempt (spec 008, AC-14). */
export type AttemptOutcome =
  | "success"
  | "retryable_error"
  | "non_retryable_error"
  | "timeout"
  | "midstream_error";

interface Instruments {
  provider: MeterProvider;
  attempts: Counter;
  circuit: Gauge;
  reloads: Counter;
}
let instruments: Instruments | undefined;

/** Bound to the current global MeterProvider (tests may swap it). */
function get(): Instruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    instruments = {
      provider,
      attempts: meter.createCounter("switchyard_upstream_attempts_total", {
        description: "Upstream attempts by candidate (provider/model) and outcome",
      }),
      circuit: meter.createGauge("switchyard_circuit_state", {
        description: "Circuit breaker state per candidate: 0 closed, 1 half-open, 2 open",
      }),
      reloads: meter.createCounter("switchyard_config_reloads_total", {
        description: "Config reloads by result (success, failure)",
      }),
    };
  }
  return instruments;
}

const STATE_VALUE: Record<BreakerState, number> = { closed: 0, "half-open": 1, open: 2 };

export function countAttempt(candidate: string, outcome: AttemptOutcome): void {
  get().attempts.add(1, { candidate, outcome });
}

export function recordCircuitState(candidate: string, state: BreakerState): void {
  get().circuit.record(STATE_VALUE[state], { candidate });
}

export function countConfigReload(result: "success" | "failure"): void {
  get().reloads.add(1, { result });
}
