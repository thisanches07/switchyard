import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../../src/infra/logger.js";
import { captureLogs } from "../../helpers/log-capture.js";

describe("createLogger", () => {
  const provider = new BasicTracerProvider();
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it("adds trace ids inside an active span", () => {
    const { stream, lines } = captureLogs();
    const logger = createLogger({ level: "info", destination: stream });
    const tracer = trace.getTracer("test");

    const ids = tracer.startActiveSpan("work", (span) => {
      logger.info("inside");
      span.end();
      return span.spanContext();
    });

    expect(lines[0]).toMatchObject({ msg: "inside", trace_id: ids.traceId, span_id: ids.spanId });
  });

  it("omits trace ids outside spans", () => {
    const { stream, lines } = captureLogs();
    createLogger({ level: "info", destination: stream }).info("outside");
    expect(lines[0]).not.toHaveProperty("trace_id");
    expect(lines[0]).not.toHaveProperty("span_id");
  });

  it("redacts authorization header", () => {
    const { stream, lines } = captureLogs();
    const logger = createLogger({ level: "info", destination: stream });
    logger.info({ req: { headers: { authorization: "Bearer sk-sy-secret", "x-api-key": "k" } } });
    expect(JSON.stringify(lines[0])).not.toContain("sk-sy-secret");
    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: "[Redacted]", "x-api-key": "[Redacted]" } },
    });
  });
});
