import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let sdk: NodeSDK | undefined;

/**
 * Starts the OpenTelemetry SDK (ADR-0011). Exporter endpoints come from the standard
 * `OTEL_EXPORTER_OTLP_*` variables. Returns false when disabled via `OTEL_SDK_DISABLED`.
 */
export function startTelemetry(env: Record<string, string | undefined>): boolean {
  if (env.OTEL_SDK_DISABLED === "true" || sdk) return false;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? "switchyard-gateway",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15_000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        // Health probes would flood traces; they still get Fastify route spans (spec 001 §6).
        ignoreIncomingRequestHook: (req) => req.url === "/healthz",
      }),
      new UndiciInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  return true;
}

/** Flushes and stops the SDK. Safe to call when it was never started. */
export async function shutdownTelemetry(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  await current?.shutdown();
}
