import type { FastifyInstance } from "fastify";
import type { DependencyCheck } from "../../core/health.js";
import { docs } from "../docs.js";
import { runReadiness } from "./readiness.js";

export interface HealthRoutesOptions {
  checks: readonly DependencyCheck[];
  readinessTimeoutMs: number;
}

export async function healthRoutes(app: FastifyInstance, opts: HealthRoutesOptions): Promise<void> {
  // Probes are frequent: only warnings and errors from these routes reach the logs.
  app.get("/healthz", { logLevel: "warn", schema: docs.health }, async () => ({ status: "ok" }));

  app.get("/readyz", { logLevel: "warn", schema: docs.health }, async (_request, reply) => {
    const result = await runReadiness(opts.checks, opts.readinessTimeoutMs);
    if (result.ready) {
      return { status: "ready", checks: result.checks };
    }
    reply.log.warn({ failing: result.failing }, "readiness check failed");
    return reply
      .code(503)
      .send({ status: "not_ready", checks: result.checks, failing: result.failing });
  });
}
