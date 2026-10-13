/**
 * Reload triggers (ADR-0018): stat polling of the config path and `SIGHUP` off Windows. Both call
 * the same reload routine; an invalid file is logged by it and never applied.
 */
import { stat } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface WatchOptions {
  path: string;
  /** Checked on every tick, so a reload can turn polling on or off (`routing.hotReload`). */
  enabled(): boolean;
  /** Throws on an invalid file (already logged and counted by the runtime). */
  reload(): unknown;
  logger: Pick<FastifyBaseLogger, "warn">;
  intervalMs?: number;
  /** Quiet time after the last change before reading, so a half-written file is not read. */
  debounceMs?: number;
  stat?: (path: string) => Promise<FileStamp | undefined>;
}

const statFile = async (path: string): Promise<FileStamp | undefined> => {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
};

/** Polls the config path every 2 s; a changed mtime or size triggers a debounced reload. */
export function watchConfigFile(options: WatchOptions): { stop(): void } {
  const read = options.stat ?? statFile;
  const debounceMs = options.debounceMs ?? 500;
  let last: FileStamp | undefined;
  let baseline = false;
  let pending: NodeJS.Timeout | undefined;
  let checking = false;

  const fire = () => {
    pending = undefined;
    try {
      options.reload();
    } catch {
      // Logged by the reload routine; the previous config keeps serving (AC-13).
    }
  };

  const tick = async () => {
    if (checking || !options.enabled()) return;
    checking = true;
    try {
      const current = await read(options.path);
      const changed =
        baseline && (current?.mtimeMs !== last?.mtimeMs || current?.size !== last?.size);
      last = current;
      baseline = true;
      if (changed) {
        if (pending) clearTimeout(pending);
        pending = setTimeout(fire, debounceMs);
        pending.unref?.();
      }
    } catch (error) {
      options.logger.warn({ err: (error as Error).message }, "config watch failed");
    } finally {
      checking = false;
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), options.intervalMs ?? 2_000);
  interval.unref?.();
  return {
    stop() {
      clearInterval(interval);
      if (pending) clearTimeout(pending);
    },
  };
}

export interface SignalTarget {
  on(event: "SIGHUP", listener: () => void): unknown;
  off(event: "SIGHUP", listener: () => void): unknown;
}

/** `SIGHUP` reloads the config on platforms that have it (not Windows). Returns an uninstaller. */
export function installReloadSignal(
  reload: () => unknown,
  options: { platform: NodeJS.Platform; target: SignalTarget },
): () => void {
  if (options.platform === "win32") return () => {};
  const listener = () => {
    try {
      reload();
    } catch {
      // Logged by the reload routine.
    }
  };
  options.target.on("SIGHUP", listener);
  return () => options.target.off("SIGHUP", listener);
}
