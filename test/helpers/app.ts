import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../../src/app.js";
import type { LoadedConfig } from "../../src/config/load.js";
import type { BudgetCounters, BudgetStore } from "../../src/core/budget.js";
import type { DependencyCheck } from "../../src/core/health.js";
import type { ChatProvider } from "../../src/core/provider.js";
import type { RateLimiter } from "../../src/core/ratelimit.js";
import type { OutcomeRecorder, UsageReader } from "../../src/core/usage.js";
import { createLogger } from "../../src/infra/logger.js";
import { MemoryRateLimiter } from "../../src/infra/memory/rate-limiter.js";
import type { PriceTable } from "../../src/modules/pricing/table.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { testConfig } from "./config.js";
import { fakeHttp, jsonResponse } from "./http.js";
import { captureLogs } from "./log-capture.js";
import { MemoryKeyStore, TEST_PEPPER } from "./memory-key-store.js";

export interface TestAppOptions {
  checks?: DependencyCheck[];
  level?: string;
  config?: LoadedConfig;
  providers?: ReadonlyMap<string, ChatProvider>;
  bodyLimitBytes?: number;
  store?: MemoryKeyStore;
  limiter?: RateLimiter;
  adminToken?: string;
  /** Receives usage events (spec 006). */
  usageRecorder?: OutcomeRecorder;
  /** Answers GET /admin/usage (spec 006). */
  usageReader?: UsageReader;
  /** Prices (spec 007); default: every cost unknown. */
  costEstimator?: PriceTable;
  /** Budget counters (spec 007); default: fresh in-memory counters. */
  budgetCounters?: BudgetCounters;
  /** Stored spend for the budget status routes (spec 007). */
  budgetStore?: BudgetStore;
  /** Clock for budget periods (spec 007). */
  clock?: () => number;
  /**
   * Default true: `app.inject` adds `Authorization: Bearer <test key>` unless the request sets
   * its own `authorization` header. Set false to exercise authentication itself.
   */
  authenticated?: boolean;
}

export async function testApp(options: TestAppOptions = {}) {
  const logs = captureLogs();
  const config = options.config ?? testConfig();
  const store = options.store ?? new MemoryKeyStore();
  const providers =
    options.providers ??
    createProviderRegistry(config, {}, { http: fakeHttp(() => jsonResponse(500, {})).client });
  const app = await buildApp({
    logger: createLogger({ level: options.level ?? "info", destination: logs.stream }),
    checks: options.checks ?? [],
    config,
    providers,
    keyStore: store,
    rateLimiter: options.limiter ?? new MemoryRateLimiter(),
    keyPepper: TEST_PEPPER,
    ...(options.adminToken === undefined ? {} : { adminToken: options.adminToken }),
    ...(options.usageRecorder === undefined ? {} : { usageRecorder: options.usageRecorder }),
    ...(options.usageReader === undefined ? {} : { usageReader: options.usageReader }),
    ...(options.costEstimator === undefined ? {} : { costEstimator: options.costEstimator }),
    ...(options.budgetCounters === undefined ? {} : { budgetCounters: options.budgetCounters }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.budgetStore === undefined ? {} : { budgetStore: options.budgetStore }),
    ...(options.bodyLimitBytes === undefined ? {} : { bodyLimitBytes: options.bodyLimitBytes }),
  });

  const { key } = await store.issueKey({ team: "default-test-team" });
  if (options.authenticated !== false) withDefaultAuth(app, key);
  return { app, logs: logs.lines, store, key };
}

/** Wraps `app.inject` so requests carry the test key unless they set `authorization`. */
function withDefaultAuth(app: FastifyInstance, key: string): void {
  const inject = app.inject.bind(app) as (opts: InjectOptions) => ReturnType<typeof app.inject>;
  const patched = (opts: InjectOptions) => {
    const headers = { ...(opts.headers ?? {}) } as Record<string, unknown>;
    if (!("authorization" in headers)) headers.authorization = `Bearer ${key}`;
    return inject({ ...opts, headers } as InjectOptions);
  };
  (app as unknown as { inject: typeof patched }).inject = patched;
}
