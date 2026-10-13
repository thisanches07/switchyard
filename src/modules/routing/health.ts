import type { FastifyBaseLogger } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { type BreakerSettings, type BreakerState, CircuitBreaker } from "./breaker.js";
import { recordCircuitState } from "./telemetry.js";

export interface HealthSettings {
  circuitBreaker: BreakerSettings;
  routing: { ewmaAlpha: number };
}

/** Attempts kept for the error rate (spec 008, AC-11). */
export const ERROR_WINDOW = 100;

/** What `GET /admin/providers/health` reports for one candidate (spec 008, AC-11). */
export interface CandidateHealthView {
  candidate: string;
  state: BreakerState;
  consecutiveFailures: number;
  /** ISO-8601 time the open breaker becomes half-open; null unless open. */
  halfOpenAt: string | null;
  latencyMs: { ewma: number | null; samples: number };
  /** Failures / attempts over the last `window` attempts (at most 100). */
  errorRate: number;
  window: number;
}

/** Breaker, latency and recent outcomes of one `provider/model`, in memory per instance. */
export class CandidateHealth {
  readonly breaker: CircuitBreaker;
  #ewma: number | undefined;
  #samples = 0;
  #window: boolean[] = [];

  constructor(
    readonly ref: string,
    private readonly settings: () => HealthSettings,
    onTransition: (ref: string, from: BreakerState, to: BreakerState, failures: number) => void,
  ) {
    this.breaker = new CircuitBreaker(
      () => settings().circuitBreaker,
      (t) => onTransition(ref, t.from, t.to, t.consecutiveFailures),
    );
  }

  /** EWMA latency in ms; undefined while cold. */
  get ewma(): number | undefined {
    return this.#ewma;
  }

  get samples(): number {
    return this.#samples;
  }

  /** `ewma = alpha × sample + (1 − alpha) × ewma` (spec 008 concepts); the first sample seeds it. */
  recordLatency(ms: number): void {
    const alpha = this.settings().routing.ewmaAlpha;
    this.#ewma = this.#ewma === undefined ? ms : alpha * ms + (1 - alpha) * this.#ewma;
    this.#samples += 1;
  }

  /** One attempt for the error rate: `ok` false for counted failures. */
  recordOutcome(ok: boolean): void {
    this.#window.push(ok);
    if (this.#window.length > ERROR_WINDOW) this.#window.shift();
  }

  view(now: number): CandidateHealthView {
    const state = this.breaker.state(now);
    const halfOpenAt = this.breaker.halfOpenAt;
    const failures = this.#window.filter((ok) => !ok).length;
    return {
      candidate: this.ref,
      state,
      consecutiveFailures: this.breaker.consecutiveFailures,
      halfOpenAt: halfOpenAt === undefined ? null : new Date(halfOpenAt).toISOString(),
      latencyMs: {
        ewma: this.#ewma === undefined ? null : Math.round(this.#ewma * 10) / 10,
        samples: this.#samples,
      },
      errorRate: this.#window.length === 0 ? 0 : failures / this.#window.length,
      window: this.#window.length,
    };
  }
}

export interface HealthRegistryDeps {
  settings: () => HealthSettings;
  logger: Pick<FastifyBaseLogger, "warn">;
}

/** Every candidate's health in this instance (spec 008). Entries are created on first use. */
export class CandidateHealthRegistry {
  readonly #entries = new Map<string, CandidateHealth>();

  constructor(private readonly deps: HealthRegistryDeps) {}

  get(ref: string): CandidateHealth {
    let entry = this.#entries.get(ref);
    if (!entry) {
      entry = new CandidateHealth(ref, this.deps.settings, (candidate, from, to, failures) => {
        // Logged once per transition (AC-14); the gauge follows the state.
        this.deps.logger.warn(
          { candidate, from, to, consecutiveFailures: failures },
          "circuit breaker state changed",
        );
        recordCircuitState(candidate, to);
      });
      this.#entries.set(ref, entry);
      recordCircuitState(ref, "closed");
    }
    return entry;
  }

  peek(ref: string): CandidateHealth | undefined {
    return this.#entries.get(ref);
  }

  /** `known` first (in order, cold defaults when unused), then other candidates used so far. */
  snapshot(now: number, known: readonly string[]): CandidateHealthView[] {
    const refs = [...new Set([...known, ...this.#entries.keys()])];
    return refs.map(
      (ref) =>
        this.#entries.get(ref)?.view(now) ?? {
          candidate: ref,
          state: "closed",
          consecutiveFailures: 0,
          halfOpenAt: null,
          latencyMs: { ewma: null, samples: 0 },
          errorRate: 0,
          window: 0,
        },
    );
  }

  /**
   * After a reload (spec 008, AC-12): keep the state of candidates whose provider definition is
   * unchanged; drop the rest (they start again closed and cold).
   */
  retain(prev: Pick<LoadedConfig, "providers">, next: Pick<LoadedConfig, "providers">): void {
    for (const ref of [...this.#entries.keys()]) {
      const provider = ref.slice(0, ref.indexOf("/"));
      const before = prev.providers[provider];
      const after = next.providers[provider];
      if (after === undefined || stableJson(before) !== stableJson(after)) {
        this.#entries.delete(ref);
        recordCircuitState(ref, "closed");
      }
    }
  }
}

/** JSON with sorted keys, so equal definitions compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
