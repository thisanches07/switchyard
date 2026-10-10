import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { spiedRegistry } from "../../helpers/providers.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const SECRET = "my card is 4111111111111111";

describe("upstream telemetry", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let meters: ReturnType<typeof installTestMetrics>;

  beforeAll(() => {
    tracing = installInMemoryTracing();
    meters = installTestMetrics();
  });
  afterAll(async () => {
    await tracing.uninstall();
    await meters.uninstall();
  });
  beforeEach(() => {
    tracing.exporter.reset();
  });

  async function call(model: string) {
    const { registry } = spiedRegistry();
    const { app, logs } = await testApp({ providers: registry });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model, messages: [{ role: "user", content: SECRET }] },
    });
    await app.close();
    const span = tracing.exporter.getFinishedSpans().find((s) => s.name === "switchyard.upstream");
    return { res, span, logs };
  }

  it("records a client span with gen_ai attributes and usage", async () => {
    const { res, span } = await call("fast");
    expect(res.statusCode).toBe(200);
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "mock",
      "gen_ai.request.model": "fast-model",
      "gen_ai.response.model": "fast-model",
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 6,
      "switchyard.provider.type": "mock",
      "http.response.status_code": 200,
    });
    expect(span?.parentSpanContext).toBeDefined();
  });

  it("marks the span as error on upstream failure and logs a warning", async () => {
    const { span, logs } = await call("mock/error-500");
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "upstream_error" });
    expect(span?.attributes["http.response.status_code"]).toBe(502);
    const warn = logs.find((l) => l.msg === "upstream request failed");
    expect(warn).toMatchObject({ provider: "mock", model: "error-500", code: "upstream_error" });
  });

  it("never records message content in spans or logs", async () => {
    const { span, logs } = await call("fast");
    expect(JSON.stringify(span?.attributes)).not.toContain("4111");
    expect(JSON.stringify(logs)).not.toContain("4111");
  });

  it("counts requests and records upstream duration by provider and model", async () => {
    await call("fast");
    await call("mock/error-500");

    const requests = await meters.points("switchyard_requests_total");
    expect(requests).toContainEqual(
      expect.objectContaining({
        attributes: { provider: "mock", model: "fast-model", status: "200" },
      }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        attributes: { provider: "mock", model: "error-500", status: "502" },
      }),
    );

    const durations = await meters.points("switchyard_upstream_duration_seconds");
    expect(durations.map((p) => p.attributes)).toContainEqual({
      provider: "mock",
      model: "error-500",
      outcome: "error",
    });
  });
});
