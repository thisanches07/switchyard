import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Probes are frequent: only warnings and errors from these routes reach the logs.
  app.get("/healthz", { logLevel: "warn" }, async () => ({ status: "ok" }));
}
