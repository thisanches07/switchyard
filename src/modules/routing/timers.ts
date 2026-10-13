import { setTimeout as sleep } from "node:timers/promises";

/** A request-wide time budget (spec 008, AC-7). */
export interface Deadline {
  /** Aborts with a `TimeoutError` DOMException when the budget runs out. */
  signal: AbortSignal;
  /** Milliseconds left (never negative). */
  remaining(): number;
  clear(): void;
}

/** Time source for routing, injected so tests (and the chaos test) never depend on the wall clock. */
export interface Timers {
  /** Epoch milliseconds. */
  now(): number;
  /** Waits `ms`; rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  deadline(ms: number): Deadline;
}

export const systemTimers: Timers = {
  // Epoch milliseconds with sub-millisecond resolution: gateway overhead is often under 1 ms.
  now: () => performance.timeOrigin + performance.now(),
  async sleep(ms, signal) {
    if (signal.aborted) throw signal.reason;
    if (ms <= 0) return;
    try {
      await sleep(ms, undefined, { signal });
    } catch {
      throw signal.reason;
    }
  },
  deadline(ms) {
    const controller = new AbortController();
    const at = Date.now() + ms;
    const timer = setTimeout(
      () => controller.abort(new DOMException("total timeout", "TimeoutError")),
      ms,
    );
    timer.unref();
    return {
      signal: controller.signal,
      remaining: () => (controller.signal.aborted ? 0 : Math.max(0, at - Date.now())),
      clear: () => clearTimeout(timer),
    };
  },
};
