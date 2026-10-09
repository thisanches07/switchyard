import { FastifyOtelInstrumentation } from "@fastify/otel";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { openAiError } from "./core/errors.js";
import type { DependencyCheck } from "./core/health.js";
import { healthRoutes } from "./modules/health/routes.js";

export interface AppDeps {
  logger: FastifyBaseLogger;
  checks: DependencyCheck[];
  bodyLimitBytes?: number;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: deps.bodyLimitBytes ?? 1_048_576,
  });

  // Request spans (ADR-0011). Uses the global tracer provider, so tests can swap it.
  await app.register(new FastifyOtelInstrumentation().plugin());

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

  await app.register(healthRoutes);
  return app;
}
