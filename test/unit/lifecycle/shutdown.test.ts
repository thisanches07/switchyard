import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../src/infra/logger.js";
import { installShutdown } from "../../../src/lifecycle/shutdown.js";

function setup(options: { appClose?: () => Promise<void>; timeoutMs?: number } = {}) {
  const calls: string[] = [];
  const exit = vi.fn<(code: number) => void>();
  const signals = new EventEmitter();
  installShutdown({
    app: {
      close: async () => {
        calls.push("app");
        await options.appClose?.();
      },
    },
    closers: [
      { name: "redis", close: async () => void calls.push("redis") },
      { name: "postgres", close: async () => void calls.push("postgres") },
      { name: "telemetry", close: async () => void calls.push("telemetry") },
    ],
    timeoutMs: options.timeoutMs ?? 9_000,
    exit,
    logger: createLogger({ level: "silent" }),
    signals,
  });
  return { calls, exit, signals };
}

describe("installShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes app then closers in order", async () => {
    const { calls, exit, signals } = setup();
    signals.emit("SIGTERM");
    await vi.runAllTimersAsync();
    expect(calls).toEqual(["app", "redis", "postgres", "telemetry"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("keeps closing remaining resources when one closer fails", async () => {
    const exit = vi.fn<(code: number) => void>();
    const signals = new EventEmitter();
    const closed: string[] = [];
    installShutdown({
      app: { close: async () => {} },
      closers: [
        {
          name: "redis",
          close: async () => {
            throw new Error("boom");
          },
        },
        { name: "postgres", close: async () => void closed.push("postgres") },
      ],
      timeoutMs: 9_000,
      exit,
      logger: createLogger({ level: "silent" }),
      signals,
    });
    signals.emit("SIGTERM");
    await vi.runAllTimersAsync();
    expect(closed).toEqual(["postgres"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("forces exit after timeout", async () => {
    const { exit, signals } = setup({
      appClose: () => new Promise(() => {}),
      timeoutMs: 9_000,
    });
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(8_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("second signal exits immediately", async () => {
    const { exit, signals } = setup({ appClose: () => new Promise(() => {}) });
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
