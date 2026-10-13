import { buildApp } from "../../src/app.js";
import type { DependencyCheck } from "../../src/core/health.js";
import { createLogger } from "../../src/infra/logger.js";
import { captureLogs } from "./log-capture.js";

export async function testApp(options: { checks?: DependencyCheck[]; level?: string } = {}) {
  const logs = captureLogs();
  const app = await buildApp({
    logger: createLogger({ level: options.level ?? "info", destination: logs.stream }),
    checks: options.checks ?? [],
  });
  return { app, logs: logs.lines };
}
