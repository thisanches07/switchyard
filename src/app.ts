import { randomUUID } from "node:crypto";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { LoadedConfig } from "./config/load.js";
import type { AuthRecord, KeyStore } from "./core/auth.js";
import type { BudgetCounters, BudgetStore } from "./core/budget.js";
import type { ExactCacheStore, SemanticCacheStore } from "./core/cache.js";
import {
  GatewayError,
  internalError,
  invalidJson,
  invalidRequest,
  openAiError,
  requestTooLarge,
  unsupportedMediaType,
} from "./core/errors.js";
import type { DependencyCheck } from "./core/health.js";
import type { CostEstimator } from "./core/pricing.js";
import type { ChatProvider } from "./core/provider.js";
import type { RateLimiter } from "./core/ratelimit.js";
import type { OutcomeRecorder, UsageReader } from "./core/usage.js";
import { MemoryBudgetCounters } from "./infra/memory/budget-counters.js";
import { MemoryExactCache } from "./infra/memory/exact-cache.js";
import { adminRoutes } from "./modules/admin/routes.js";
import {
  anthropicRateLimitHeaders,
  toAnthropicErrorBody,
} from "./modules/anthropic/inbound-errors.js";
import { AuthCache } from "./modules/auth/cache.js";
import { recordAuthFailure } from "./modules/auth/telemetry.js";
import { createBudgets } from "./modules/budgets/service.js";
import { type ConfigRuntime, createConfigRuntime } from "./modules/config/runtime.js";
import { openApiInfo } from "./modules/docs.js";
import { healthRoutes } from "./modules/health/routes.js";
import { PriceTable, priceEvent } from "./modules/pricing/table.js";
import { proxyRoutes } from "./modules/proxy/routes.js";
import { countRejection, createAdmission } from "./modules/ratelimit/admission.js";
import { CandidateHealthRegistry } from "./modules/routing/health.js";
import { aliasCandidates } from "./modules/routing/resolve.js";
import { systemTimers, type Timers } from "./modules/routing/timers.js";
import { createOutcomeHook } from "./modules/usage/outcome.js";
import { fanOut, noopRecorder } from "./modules/usage/recorders.js";
import { tokenMetricsRecorder } from "./modules/usage/token-metrics.js";

export interface AppDeps {
  logger: FastifyBaseLogger;
  checks: DependencyCheck[];
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  keyStore: KeyStore;
  rateLimiter: RateLimiter;
  /** Secret mixed into key hashes (KEY_PEPPER). */
  keyPepper: string;
  /** Enables the admin API when set (ADMIN_TOKEN). */
  adminToken?: string | undefined;
  /** Receives one usage event per admitted request (spec 006); defaults to discarding them. */
  usageRecorder?: OutcomeRecorder;
  /** Answers GET /admin/usage (spec 006); the route returns 503 without it. */
  usageReader?: UsageReader;
  /**
   * Prices (spec 007): `estimateUsd` for routing (spec 008). A `PriceTable` (config/pricing.yaml)
   * also gives exact event costs; any other estimator, or none, leaves every event cost unknown.
   */
  costEstimator?: CostEstimator;
  /** Budget counters (spec 007, Redis in production); defaults to in-process counters. */
  budgetCounters?: BudgetCounters;
  /** Stored spend for GET /admin/keys|teams/:id/budget (spec 007); those routes 503 without it. */
  budgetStore?: BudgetStore;
  /** Clock for budget periods (spec 007); tests inject one. Defaults to `Date.now`. */
  clock?: () => number;
  /** Exact response cache (spec 009, Redis in production); defaults to an in-process cache. */
  exactCache?: ExactCacheStore;
  /** Semantic response cache (spec 009, pgvector); without it the semantic layer is off. */
  semanticCache?: SemanticCacheStore;
  bodyLimitBytes?: number;
  readinessTimeoutMs?: number;
  /**
   * The live config (spec 008 hot reload); `config` and `providers` are its initial snapshot.
   * Without it the config is static.
   */
  runtime?: ConfigRuntime | undefined;
  /** Clock and randomness for retries and breakers (spec 008); tests inject deterministic ones. */
  routing?: { timers?: Timers; random?: () => number } | undefined;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: deps.bodyLimitBytes ?? deps.config.server.bodyLimitBytes,
    genReqId: () => `req_${randomUUID()}`,
    // Client address from X-Forwarded-For only behind a trusted proxy (spec 005).
    trustProxy: deps.config.server.trustProxy,
  });

  // JSON-only API: anything else gets 415 instead of reaching a route as a string.
  app.removeContentTypeParser("text/plain");

  // ADR-0014: route schemas only document the API. Zod validates; bodies are sent untouched.
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  await app.register(swagger, openApiInfo);
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Request spans (ADR-0011). Uses the global tracer provider, so tests can swap it.
  await app.register(new FastifyOtelInstrumentation().plugin());

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-switchyard-request-id", request.id);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const gatewayError = toGatewayError(error, request);
    if (gatewayError.code === "internal_error") {
      request.log.error({ err: error }, "unhandled error");
    }
    // ADR-0016: the route the client called decides the error shape.
    if (request.routeOptions.config?.api === "anthropic") {
      return reply
        .code(gatewayError.status)
        .headers(gatewayError.headers)
        .headers(anthropicRateLimitHeaders(gatewayError.headers, Date.now()))
        .header("request-id", request.id)
        .send(toAnthropicErrorBody(gatewayError, request.id));
    }
    return reply
      .code(gatewayError.status)
      .headers(gatewayError.headers)
      .send(gatewayError.toBody());
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(
        openAiError(
          `Route ${request.method} ${request.url} not found`,
          "invalid_request_error",
          "not_found",
        ),
      );
  });

  await app.register(healthRoutes, {
    checks: deps.checks,
    readinessTimeoutMs: deps.readinessTimeoutMs ?? 1_000,
  });
  // Validated keys, shared by the auth hook and the admin API (revocations invalidate it).
  const authCache = new AuthCache<AuthRecord>({ ttlMs: 30_000, maxEntries: 10_000 });

  // The live config (spec 008): requests read a snapshot; reloads swap it for new requests.
  const runtime =
    deps.runtime ??
    createConfigRuntime({
      initial: { config: deps.config, providers: deps.providers },
      buildProviders: () => deps.providers,
      logger: deps.logger,
    });

  const admission = createAdmission({
    limiter: deps.rateLimiter,
    config: () => runtime.current().config.limits,
    logger: deps.logger,
  });

  // Monthly budgets (spec 007): checked before rate limiting, charged when a request ends.
  const budgetCounters = deps.budgetCounters ?? new MemoryBudgetCounters();
  const budgets = createBudgets({
    counters: budgetCounters,
    // Read per check from the live config, so a reloaded `budgets.onRedisError` applies (spec 008).
    config: {
      get onRedisError() {
        return runtime.current().config.budgets.onRedisError;
      },
      // The usage worker's setting; it reads the file when it starts.
      get reconcileIntervalSeconds() {
        return runtime.current().config.budgets.reconcileIntervalSeconds;
      },
    },
    logger: deps.logger,
    ...(deps.clock ? { now: deps.clock } : {}),
  });
  app.addHook("onClose", async () => budgets.close());

  // The request-outcome hook (spec 006); later specs extend the recorder, not the routes.
  // Spec 007: every event is priced, then charged to the budget counters and published.
  const outcomes = createOutcomeHook({
    // Spec 011: token counter from the same events.
    recorder: fanOut(budgets.charger, tokenMetricsRecorder, deps.usageRecorder ?? noopRecorder),
    logger: deps.logger,
    price: priceEvent(
      deps.costEstimator instanceof PriceTable ? deps.costEstimator : PriceTable.empty(),
    ),
    ...(deps.clock ? { now: deps.clock } : {}),
  });

  // Breaker and latency state per candidate, in memory per instance (spec 008).
  const health = new CandidateHealthRegistry({
    settings: () => runtime.current().config,
    logger: deps.logger,
  });
  runtime.onChange((prev, next) => health.retain(prev, next));
  const timers = deps.routing?.timers ?? systemTimers;

  await app.register(proxyRoutes, {
    runtime,
    admission,
    budgets: budgets.check,
    outcomes,
    routing: {
      health,
      timers,
      random: deps.routing?.random ?? Math.random,
      costEstimator: deps.costEstimator,
    },
    auth: {
      store: deps.keyStore,
      pepper: deps.keyPepper,
      cache: authCache,
      onFailure: recordAuthFailure,
      failureLimit: {
        limiter: deps.rateLimiter,
        perMinute: deps.config.limits.authFailuresPerMinutePerIp,
        onRejected: () => countRejection("ip", "requests"),
      },
    },
    startedAt: Math.floor(Date.now() / 1000),
    // Spec 009: used only when `cache.*.enabled` (config) allows it.
    cache: {
      exact: deps.exactCache ?? new MemoryExactCache(deps.clock ? { now: deps.clock } : {}),
      semantic: deps.semanticCache,
      clock: deps.clock,
    },
  });

  // Not registered at all without ADMIN_TOKEN: the routes 404 (spec 004, AC-8).
  if (deps.adminToken) {
    await app.register(adminRoutes, {
      store: deps.keyStore,
      pepper: deps.keyPepper,
      adminToken: deps.adminToken,
      cache: authCache,
      usage: deps.usageReader,
      budgets: { counters: budgetCounters, store: deps.budgetStore, now: deps.clock ?? Date.now },
      routing: {
        health: () =>
          health.snapshot(timers.now(), aliasCandidates(runtime.current().config.aliases)),
        reload: () => runtime.reload(),
      },
    });
  }
  return app;
}

/** Maps any thrown error to the OpenAI error shape (spec 002 design §4.2). */
function toGatewayError(error: FastifyError, request: FastifyRequest): GatewayError {
  if (error instanceof GatewayError) return error;
  switch (error.code) {
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return invalidJson(error.message);
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return requestTooLarge();
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return unsupportedMediaType(request.headers["content-type"] ?? "none");
  }
  if (error instanceof SyntaxError && error.statusCode === 400) return invalidJson(error.message);
  if (error.validation) return invalidRequest(error.message);
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return new GatewayError(
      error.statusCode,
      "invalid_request_error",
      "invalid_request",
      error.message,
    );
  }
  return internalError();
}
