import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

describe("trace/log correlation", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;

  beforeAll(() => {
    tracing = installInMemoryTracing();
  });

  afterAll(async () => {
    await tracing.uninstall();
  });

  it("request span traceId equals log trace_id", async () => {
    const { app, logs } = await testApp();
    await app.inject({ method: "GET", url: "/nope" });
    await app.close();

    const spans = tracing.exporter.getFinishedSpans();
    const root = spans.find((s) => s.parentSpanContext === undefined);
    expect(root, `spans: ${spans.map((s) => s.name).join(", ")}`).toBeDefined();

    const completed = logs.filter((l) => l.msg === "request completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.trace_id).toBe(root?.spanContext().traceId);
    expect(completed[0]?.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});
