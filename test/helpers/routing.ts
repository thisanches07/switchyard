import type { Deadline, Timers } from "../../src/modules/routing/timers.js";

/** mulberry32: a small seeded PRNG in [0, 1), so retries and failures repeat exactly per seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A manual clock: `sleep` advances time at once (no real waiting) and records the wait;
 * deadlines fire when time is advanced past them. Deterministic, no wall clock.
 */
export function manualTimers(start = 1_000_000) {
  let now = start;
  const pending = new Set<{ at: number; controller: AbortController }>();
  const sleeps: number[] = [];

  function advance(ms: number): void {
    now += ms;
    for (const entry of [...pending]) {
      if (entry.at <= now) {
        pending.delete(entry);
        entry.controller.abort(new DOMException("total timeout", "TimeoutError"));
      }
    }
  }

  const timers: Timers & { advance(ms: number): void; sleeps: number[] } = {
    now: () => now,
    async sleep(ms, signal) {
      if (signal.aborted) throw signal.reason;
      sleeps.push(ms);
      advance(ms);
      if (signal.aborted) throw signal.reason;
    },
    deadline(ms): Deadline {
      const entry = { at: now + ms, controller: new AbortController() };
      pending.add(entry);
      return {
        signal: entry.controller.signal,
        remaining: () => Math.max(0, entry.at - now),
        clear: () => {
          pending.delete(entry);
        },
      };
    },
    advance,
    sleeps,
  };
  return timers;
}

/** Real clock, but every backoff wait is skipped (unit tests of the HTTP routes). */
export function instantTimers(): Timers {
  return {
    now: () => Date.now(),
    sleep: async (_ms, signal) => {
      if (signal.aborted) throw signal.reason;
    },
    deadline: (ms) => {
      const controller = new AbortController();
      const at = Date.now() + ms;
      const timer = setTimeout(
        () => controller.abort(new DOMException("total timeout", "TimeoutError")),
        ms,
      );
      timer.unref?.();
      return {
        signal: controller.signal,
        remaining: () => (controller.signal.aborted ? 0 : Math.max(0, at - Date.now())),
        clear: () => clearTimeout(timer),
      };
    },
  };
}
