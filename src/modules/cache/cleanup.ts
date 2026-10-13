/**
 * Deletes expired semantic cache entries (spec 009, AC-6). Expired entries are never served
 * (the search filters `expires_at > now`); this only reclaims space. Runs at start and hourly in
 * every gateway instance; the DELETE is idempotent.
 */
import type { SemanticCacheStore } from "../../core/cache.js";

export const CLEANUP_INTERVAL_MS = 3_600_000;

export interface CleanupLogger {
  info(fields: object, msg: string): void;
  warn(fields: object, msg: string): void;
}

/** One pass; never throws (a failure is logged and retried at the next pass). */
export async function runSemanticCleanup(
  store: Pick<SemanticCacheStore, "deleteExpired">,
  now: Date,
  logger: CleanupLogger,
): Promise<number> {
  try {
    const deleted = await store.deleteExpired(now);
    if (deleted > 0) logger.info({ deleted }, "expired semantic cache entries deleted");
    return deleted;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "semantic cache cleanup failed",
    );
    return 0;
  }
}

export interface CleanupSchedule {
  store: Pick<SemanticCacheStore, "deleteExpired">;
  clock: () => number;
  logger: CleanupLogger;
  intervalMs?: number;
  /** Injected for tests; defaults to the global timers (unref'd). */
  every?: (fn: () => void, ms: number) => { stop(): void };
}

const globalEvery = (fn: () => void, ms: number) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

/** Runs a pass now and then every `intervalMs` (default one hour); `stop()` ends it. */
export function scheduleSemanticCleanup(options: CleanupSchedule): { stop(): void } {
  const pass = () => {
    void runSemanticCleanup(options.store, new Date(options.clock()), options.logger);
  };
  pass();
  return (options.every ?? globalEvery)(pass, options.intervalMs ?? CLEANUP_INTERVAL_MS);
}
