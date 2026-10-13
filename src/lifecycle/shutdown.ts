import type { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";

export interface Closer {
  name: string;
  /** `deadlineAt`: epoch ms at which the process is forced to exit (e.g. to bound a flush). */
  close(context: { deadlineAt: number }): Promise<void>;
}

export interface ShutdownOptions {
  /** Stops accepting connections and waits for in-flight requests (Fastify `close`). */
  app: { close(): Promise<unknown> };
  /** Closed in order after the app, e.g. Redis, Postgres, telemetry. */
  closers: readonly Closer[];
  /** Hard deadline; the process exits with code 1 if shutdown takes longer. */
  timeoutMs: number;
  logger: FastifyBaseLogger;
  exit?: (code: number) => void;
  /** Source of signals; defaults to `process`. */
  signals?: EventEmitter;
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export function installShutdown(options: ShutdownOptions): void {
  const { app, closers, timeoutMs, logger } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? process;
  let shuttingDown = false;

  const onSignal = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, "second signal received, exiting immediately");
      exit(1);
      return;
    }
    shuttingDown = true;
    const deadlineAt = Date.now() + timeoutMs;
    logger.info({ signal, timeoutMs }, "shutdown started");

    const deadline = setTimeout(() => {
      logger.error({ timeoutMs }, "shutdown timed out, forcing exit");
      exit(1);
    }, timeoutMs);
    deadline.unref?.();

    let failed = false;
    try {
      await app.close();
    } catch (error) {
      failed = true;
      logger.error({ err: error }, "failed to close HTTP server");
    }
    for (const closer of closers) {
      try {
        await closer.close({ deadlineAt });
      } catch (error) {
        failed = true;
        logger.error({ err: error, resource: closer.name }, "failed to close resource");
      }
    }

    clearTimeout(deadline);
    logger.info({ failed }, "shutdown complete");
    exit(failed ? 1 : 0);
  };

  for (const signal of SIGNALS) {
    signals.on(signal, (received: string | undefined) => void onSignal(received ?? signal));
  }
}
