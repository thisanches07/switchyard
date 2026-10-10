import { buildApp } from "../../src/app.js";
import type { LoadedConfig } from "../../src/config/load.js";
import type { DependencyCheck } from "../../src/core/health.js";
import type { ChatProvider } from "../../src/core/provider.js";
import { createLogger } from "../../src/infra/logger.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { testConfig } from "./config.js";
import { fakeHttp, jsonResponse } from "./http.js";
import { captureLogs } from "./log-capture.js";

export interface TestAppOptions {
  checks?: DependencyCheck[];
  level?: string;
  config?: LoadedConfig;
  providers?: ReadonlyMap<string, ChatProvider>;
  bodyLimitBytes?: number;
}

export async function testApp(options: TestAppOptions = {}) {
  const logs = captureLogs();
  const config = options.config ?? testConfig();
  const providers =
    options.providers ??
    createProviderRegistry(config, {}, { http: fakeHttp(() => jsonResponse(500, {})).client });
  const app = await buildApp({
    logger: createLogger({ level: options.level ?? "info", destination: logs.stream }),
    checks: options.checks ?? [],
    config,
    providers,
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
  });
  return { app, logs: logs.lines };
}
