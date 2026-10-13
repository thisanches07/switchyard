import { randomUUID } from "node:crypto";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { LoadedConfig } from "./config/load.js";
import type { ApiKeyRecord, KeyStore } from "./core/auth.js";
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
import type { ChatProvider } from "./core/provider.js";
import { AuthCache } from "./modules/auth/cache.js";
import { healthRoutes } from "./modules/health/routes.js";
import { proxyRoutes } from "./modules/proxy/routes.js";

export interface AppDeps {
  logger: FastifyBaseLogger;
  checks: DependencyCheck[];
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  keyStore: KeyStore;
  /** Secret mixed into key hashes (KEY_PEPPER). */
  keyPepper: string;
  /** Enables the admin API when set (ADMIN_TOKEN). */
  adminToken?: string | undefined;
  bodyLimitBytes?: number;
  readinessTimeoutMs?: number;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: deps.bodyLimitBytes ?? deps.config.server.bodyLimitBytes,
    genReqId: () => `req_${randomUUID()}`,
  });

  // JSON-only API: anything else gets 415 instead of reaching a route as a string.
  app.removeContentTypeParser("text/plain");

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
    return reply.code(gatewayError.status).send(gatewayError.toBody());
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
  const authCache = new AuthCache<ApiKeyRecord>({ ttlMs: 30_000, maxEntries: 10_000 });

  await app.register(proxyRoutes, {
    config: deps.config,
    providers: deps.providers,
    auth: { store: deps.keyStore, pepper: deps.keyPepper, cache: authCache },
    startedAt: Math.floor(Date.now() / 1000),
  });
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
