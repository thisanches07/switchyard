import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FileStamp,
  installReloadSignal,
  watchConfigFile,
} from "../../../src/modules/config/watch.js";

describe("watchConfigFile (spec 008, AC-12; ADR-0018)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(options: { enabled?: () => boolean; reload?: () => unknown } = {}) {
    let stamp: FileStamp | undefined = { mtimeMs: 1, size: 10 };
    const reloads: number[] = [];
    const watcher = watchConfigFile({
      path: "config.yaml",
      enabled: options.enabled ?? (() => true),
      reload:
        options.reload ??
        (() => {
          reloads.push(Date.now());
        }),
      logger: { warn: () => {} } as never,
      stat: async () => stamp,
    });
    const write = (next: FileStamp | undefined) => {
      stamp = next;
    };
    return { watcher, reloads, write };
  }

  it("reloads within 2.5 s of a change (poll every 2 s, 500 ms debounce)", async () => {
    const { watcher, reloads, write } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const changedAt = Date.now();
    write({ mtimeMs: 2, size: 10 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(reloads).toHaveLength(1);
    expect((reloads[0] ?? Infinity) - changedAt).toBeLessThanOrEqual(2_500);
    watcher.stop();
  });

  it("does nothing while the file is unchanged", async () => {
    const { watcher, reloads } = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reloads).toHaveLength(0);
    watcher.stop();
  });

  it("debounces several changes into one reload", async () => {
    const { watcher, reloads, write } = setup();
    await vi.advanceTimersByTimeAsync(0);
    write({ mtimeMs: 2, size: 10 });
    await vi.advanceTimersByTimeAsync(2_000);
    write({ mtimeMs: 3, size: 11 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reloads).toHaveLength(1);
    watcher.stop();
  });

  it("a size change or a deleted file counts as a change", async () => {
    const { watcher, reloads, write } = setup();
    await vi.advanceTimersByTimeAsync(0);
    write({ mtimeMs: 1, size: 12 });
    await vi.advanceTimersByTimeAsync(2_500);
    write(undefined);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(reloads).toHaveLength(2);
    watcher.stop();
  });

  it("skips polling while routing.hotReload is false", async () => {
    let enabled = false;
    const { watcher, reloads, write } = setup({ enabled: () => enabled });
    write({ mtimeMs: 5, size: 1 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reloads).toHaveLength(0);
    enabled = true;
    await vi.advanceTimersByTimeAsync(2_000);
    write({ mtimeMs: 6, size: 1 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(reloads).toHaveLength(1);
    watcher.stop();
  });

  it("survives an invalid file and stops cleanly", async () => {
    const { watcher, write } = setup({
      reload: () => {
        throw new Error("invalid");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    write({ mtimeMs: 9, size: 9 });
    await vi.advanceTimersByTimeAsync(2_500);
    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("installReloadSignal", () => {
  it("reloads on SIGHUP off Windows, and can be removed", () => {
    const target = new EventEmitter();
    let reloads = 0;
    const uninstall = installReloadSignal(
      () => {
        reloads += 1;
        throw new Error("invalid file is fine");
      },
      { platform: "linux", target },
    );
    target.emit("SIGHUP");
    expect(reloads).toBe(1);
    uninstall();
    expect(target.listenerCount("SIGHUP")).toBe(0);
  });

  it("is not installed on Windows", () => {
    const target = new EventEmitter();
    installReloadSignal(() => {}, { platform: "win32", target })();
    expect(target.listenerCount("SIGHUP")).toBe(0);
  });
});
