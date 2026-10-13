export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerSettings {
  failureThreshold: number;
  openMs: number;
}

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  consecutiveFailures: number;
}

/** Leave to make one attempt. Settles exactly once; later calls are ignored. */
export interface BreakerPermit {
  /** True for the single half-open probe. */
  readonly probe: boolean;
  /** The candidate answered (response, or first chunk for streams). */
  succeed(): void;
  /** A counted failure (retryable, timeout). */
  fail(now: number): void;
  /** Neither success nor failure (non-retryable 4xx, client gone, attempt never made). */
  release(): void;
}

/**
 * Per-candidate circuit breaker (spec 008, AC-8). Pure: time comes in as `now` arguments and
 * settings through a getter, so reloaded thresholds apply. `open` becomes `half-open` lazily,
 * the first time it is observed after `openMs`.
 */
export class CircuitBreaker {
  #state: BreakerState = "closed";
  #failures = 0;
  #openUntil: number | undefined;
  #probeInFlight = false;

  constructor(
    private readonly settings: () => BreakerSettings,
    private readonly onTransition: (transition: BreakerTransition) => void = () => {},
  ) {}

  get consecutiveFailures(): number {
    return this.#failures;
  }

  /** When an open breaker becomes half-open; undefined unless open. */
  get halfOpenAt(): number | undefined {
    return this.#state === "open" ? this.#openUntil : undefined;
  }

  state(now: number): BreakerState {
    if (this.#state === "open" && this.#openUntil !== undefined && now >= this.#openUntil) {
      this.#move("half-open");
    }
    return this.#state;
  }

  /** Whether a call would be admitted now (closed, or half-open with no probe in flight). */
  admits(now: number): boolean {
    const state = this.state(now);
    return state === "closed" || (state === "half-open" && !this.#probeInFlight);
  }

  tryAcquire(now: number): BreakerPermit | undefined {
    if (!this.admits(now)) return undefined;
    const probe = this.#state === "half-open";
    if (probe) this.#probeInFlight = true;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (probe) this.#probeInFlight = false;
      fn();
    };
    return {
      probe,
      succeed: () =>
        settle(() => {
          if (probe) {
            this.#failures = 0;
            this.#move("closed");
          } else if (this.#state === "closed") {
            this.#failures = 0;
          }
        }),
      fail: (at) =>
        settle(() => {
          if (probe) {
            this.#failures += 1;
            this.#open(at);
          } else {
            this.recordFailure(at);
          }
        }),
      release: () => settle(() => {}),
    };
  }

  /** A failure outside a permit: a stream that failed after its first chunk (ADR-0008). */
  recordFailure(now: number): void {
    if (this.#state !== "closed") return;
    this.#failures += 1;
    if (this.#failures >= this.settings().failureThreshold) this.#open(now);
  }

  #open(now: number): void {
    this.#openUntil = now + this.settings().openMs;
    this.#move("open");
  }

  #move(to: BreakerState): void {
    const from = this.#state;
    this.#state = to;
    if (to !== "open") this.#openUntil = undefined;
    if (from !== to) this.onTransition({ from, to, consecutiveFailures: this.#failures });
  }
}
