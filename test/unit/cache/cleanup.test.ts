import { describe, expect, it } from "vitest";
import {
  CLEANUP_INTERVAL_MS,
  runSemanticCleanup,
  scheduleSemanticCleanup,
} from "../../../src/modules/cache/cleanup.js";

const logger = () => {
  const lines: [string, unknown][] = [];
  return {
    lines,
    info: (fields: object, msg: string) => {
      lines.push([msg, fields]);
    },
    warn: (fields: object, msg: string) => {
      lines.push([msg, fields]);
    },
  };
};

describe("semantic cache cleanup (spec 009, AC-6)", () => {
  it("deletes entries expired at the given time and logs how many", async () => {
    const seen: Date[] = [];
    const log = logger();
    const deleted = await runSemanticCleanup(
      {
        deleteExpired: async (now) => {
          seen.push(now);
          return 3;
        },
      },
      new Date(5_000),
      log,
    );
    expect(deleted).toBe(3);
    expect(seen).toEqual([new Date(5_000)]);
    expect(log.lines).toEqual([["expired semantic cache entries deleted", { deleted: 3 }]]);
  });

  it("never throws: a failure is logged and counted as 0", async () => {
    const log = logger();
    const failing = { deleteExpired: async () => Promise.reject(new Error("db down")) };
    expect(await runSemanticCleanup(failing, new Date(0), log)).toBe(0);
    expect(log.lines).toEqual([["semantic cache cleanup failed", { err: "db down" }]]);
  });

  it("runs at start and then every hour", async () => {
    let now = 1_000;
    const calls: Date[] = [];
    let tick: (() => void) | undefined;
    let interval = 0;
    let stopped = false;
    const schedule = scheduleSemanticCleanup({
      store: {
        deleteExpired: async (at) => {
          calls.push(at);
          return 0;
        },
      },
      clock: () => now,
      logger: logger(),
      every: (fn, ms) => {
        tick = fn;
        interval = ms;
        return { stop: () => (stopped = true) };
      },
    });
    expect(interval).toBe(CLEANUP_INTERVAL_MS);
    now = 2_000;
    tick?.();
    await Promise.resolve();
    expect(calls).toEqual([new Date(1_000), new Date(2_000)]);
    schedule.stop();
    expect(stopped).toBe(true);
  });
});
