/** A dependency the gateway needs to serve traffic (Postgres, Redis, …). */
export interface DependencyCheck {
  readonly name: string;
  /** Resolves when healthy; rejects otherwise. Must stop work when `signal` aborts. */
  check(signal: AbortSignal): Promise<void>;
}

export type CheckStatus = "ok" | "error" | "timeout";

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, CheckStatus>;
  failing: string[];
}
