import { type Counter, type MeterProvider, metrics, type Span } from "@opentelemetry/api";
import type { FastifyRequest } from "fastify";
import type { AuthFailureReason } from "./authenticate.js";

let counter: { provider: MeterProvider; failures: Counter } | undefined;

/** `switchyard_auth_failures_total{reason}` (spec 004, design §5). */
export function recordAuthFailure(reason: AuthFailureReason): void {
  const provider = metrics.getMeterProvider();
  if (counter?.provider !== provider) {
    counter = {
      provider,
      failures: provider.getMeter("switchyard").createCounter("switchyard_auth_failures_total", {
        description: "Rejected /v1 requests by reason",
      }),
    };
  }
  counter.failures.add(1, { reason });
}

/**
 * Tags the request span with the caller's team and key ids (never the key itself).
 * Inside hooks the active span is the hook's own span, so the request span is taken from
 * `@fastify/otel`'s request context.
 */
export function tagRequestSpan(request: FastifyRequest): void {
  const principal = request.principal;
  if (!principal) return;
  const span: Span | null | undefined =
    typeof request.opentelemetry === "function" ? request.opentelemetry().span : undefined;
  span?.setAttributes({
    "switchyard.team_id": principal.teamId,
    "switchyard.key_id": principal.keyId,
  });
}
