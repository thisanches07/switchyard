import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upstreamTimeout } from "../../../src/core/errors.js";
import { createLogger } from "../../../src/infra/logger.js";
import { startUpstreamSpan, tracedUpstreamCall } from "../../../src/modules/proxy/telemetry.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { spiedRegistry } from "../../helpers/providers.js";
import { installInMemoryTracing, isUpstreamSpan } from "../../helpers/telemetry.js";

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
    const span = tracing.exporter.getFinishedSpans().find(isUpstreamSpan);
    return { res, span, logs };
  }

  it("records a client span with gen_ai attributes and usage", async () => {
    const { res, span } = await call("fast");
    expect(res.statusCode).toBe(200);
    expect(span?.kind).toBe(SpanKind.CLIENT);
    // GenAI semantic conventions (spec 011, AC-4): name `{operation} {model}`.
    expect(span?.name).toBe("chat fast-model");
    expect(span?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "mock",
      "gen_ai.request.model": "fast-model",
      "gen_ai.response.model": "fast-model",
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 6,
      "switchyard.stage": "upstream",
      "switchyard.provider.name": "mock",
      "switchyard.provider.type": "mock",
      "http.response.status_code": 200,
    });
    expect(span?.attributes).not.toHaveProperty("gen_ai.system");
    expect(span?.attributes).not.toHaveProperty("error.type");
    expect(span?.parentSpanContext).toBeDefined();
  });

  it("marks the span as error on upstream failure and logs a warning", async () => {
    const { span, logs } = await call("mock/error-500");
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "upstream_error" });
    expect(span?.attributes["error.type"]).toBe("upstream_error");
    expect(span?.attributes["http.response.status_code"]).toBe(502);
    const warn = logs.find((l) => l.msg === "upstream request failed");
    expect(warn).toMatchObject({ provider: "mock", model: "error-500", code: "upstream_error" });
  });

  it("never records message content in spans or logs", async () => {
    const { span, logs } = await call("fast");
    // Look for the whole sentence, not a digit run: random trace and span ids are hex.
    expect(JSON.stringify(span?.attributes)).not.toContain("my card is");
    expect(JSON.stringify(logs)).not.toContain("my card is");
    expect(JSON.stringify(span?.attributes)).not.toContain("4111111111111111");
    expect(JSON.stringify(logs)).not.toContain("4111111111111111");
  });

  it("counts requests and records upstream duration by provider and model", async () => {
    await call("fast");
    await call("mock/error-500");

    const requests = await meters.points("switchyard_requests_total");
    expect(requests).toContainEqual(
      expect.objectContaining({
        attributes: {
          provider: "mock",
          model: "fast-model",
          status: "200",
          team: expect.any(String),
          cache: "bypass",
        },
      }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        attributes: {
          provider: "mock",
          model: "error-500",
          status: "502",
          team: expect.any(String),
          cache: "bypass",
        },
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

describe("upstream span handle (streaming)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let meters: ReturnType<typeof installTestMetrics>;
  const provider = { name: "mock", type: "mock" };

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

  const logs = () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: "info",
      destination: { write: (s: string) => void lines.push(JSON.parse(s)) },
    });
    return { logger, lines };
  };
  const lastSpan = () => tracing.exporter.getFinishedSpans().at(-1);

  it("records TTFB, usage and the estimated flag for a completed stream", async () => {
    const { logger } = logs();
    const upstream = startUpstreamSpan({ provider, model: "stream-ok", logger, stream: true });
    await new Promise((r) => setTimeout(r, 20));
    const ttfb = upstream.firstChunk();
    upstream.succeed({ usage: { inputTokens: 3, outputTokens: 9 }, estimated: true });

    expect(ttfb).toBeGreaterThanOrEqual(15);
    expect(lastSpan()?.attributes).toMatchObject({
      "switchyard.stream": true,
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 9,
      "switchyard.usage.estimated": true,
    });
    expect(lastSpan()?.attributes["switchyard.ttfb_ms"]).toBeGreaterThanOrEqual(15);
    const ttfbPoints = await meters.points("switchyard_ttfb_seconds");
    expect(ttfbPoints.map((p) => p.attributes)).toContainEqual({
      provider: "mock",
      model: "stream-ok",
    });
  });

  it("records mid-stream failures with their own status and a warning", async () => {
    const { logger, lines } = logs();
    const upstream = startUpstreamSpan({ provider, model: "stream-mid", logger, stream: true });
    upstream.firstChunk();
    upstream.fail(upstreamTimeout("mock"), "midstream");
    upstream.succeed({});

    expect(lastSpan()?.status).toEqual({ code: SpanStatusCode.ERROR, message: "upstream_timeout" });
    expect(lastSpan()?.attributes["switchyard.midstream_error"]).toBe(true);
    expect(lines.some((l) => l.msg === "upstream stream failed after first byte")).toBe(true);
    const requests = await meters.points("switchyard_requests_total");
    expect(requests.map((p) => p.attributes)).toContainEqual({
      provider: "mock",
      model: "stream-mid",
      status: "upstream_error_midstream",
      team: "none",
      cache: "bypass",
    });
    expect(tracing.exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("records client disconnects as 499", async () => {
    const { logger } = logs();
    const upstream = startUpstreamSpan({ provider, model: "stream-gone", logger, stream: true });
    upstream.clientGone();
    expect(lastSpan()?.attributes["switchyard.client_closed"]).toBe(true);
    const requests = await meters.points("switchyard_requests_total");
    expect(requests.map((p) => p.attributes)).toContainEqual({
      provider: "mock",
      model: "stream-gone",
      status: "499",
      team: "none",
      cache: "bypass",
    });
  });

  it("uses the embeddings operation name", async () => {
    const { logger } = logs();
    await tracedUpstreamCall(
      { provider, model: "embed-model", logger, operation: "embeddings" },
      async () => ({ usage: { inputTokens: 4 } }),
    );
    expect(lastSpan()?.name).toBe("embeddings embed-model");
    expect(lastSpan()?.attributes).toMatchObject({
      "gen_ai.operation.name": "embeddings",
      "gen_ai.usage.input_tokens": 4,
    });
    expect(lastSpan()?.attributes).not.toHaveProperty("gen_ai.usage.output_tokens");
  });

  it("names the GenAI provider: configured, anthropic by type, else the config name", async () => {
    const { logger } = logs();
    const names: unknown[] = [];
    for (const info of [
      { provider: { name: "gem", type: "openai-compatible" }, genAiProviderName: "gcp.gemini" },
      { provider: { name: "claude", type: "anthropic" } },
      { provider: { name: "ollama", type: "openai-compatible" } },
    ]) {
      await tracedUpstreamCall({ ...info, model: "m", logger }, async () => ({}));
      const attributes = lastSpan()?.attributes ?? {};
      names.push([attributes["gen_ai.provider.name"], attributes["switchyard.provider.name"]]);
    }
    expect(names).toEqual([
      ["gcp.gemini", "gem"],
      ["anthropic", "claude"],
      ["ollama", "ollama"],
    ]);
  });

  it("sets error.type to the gateway error code on mid-stream failures", async () => {
    const { logger } = logs();
    const upstream = startUpstreamSpan({ provider, model: "m", logger, stream: true });
    upstream.firstChunk();
    upstream.fail(upstreamTimeout("mock"), "midstream");
    expect(lastSpan()?.attributes["error.type"]).toBe("upstream_timeout");
  });

  it("uses the provider name configured for the candidate through the app", async () => {
    const config = testConfig();
    config.providers.mock = {
      type: "mock",
      latencyMs: 0,
      errorRate: 0,
      chunkDelayMs: 0,
      genAiProviderName: "openai",
    };
    const { app } = await testApp({ config });
    tracing.exporter.reset();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/x", messages: [{ role: "user", content: "hi" }] },
    });
    await app.close();
    const span = tracing.exporter.getFinishedSpans().find(isUpstreamSpan);
    expect(span?.attributes["gen_ai.provider.name"]).toBe("openai");
    expect(span?.attributes["switchyard.provider.name"]).toBe("mock");
  });
});

describe("team and key telemetry (spec 004)", () => {
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

  it("labels requests with the team and tags spans with team and key ids", async () => {
    const { app, store } = await testApp({ authenticated: false });
    const { key, record, team } = await store.issueKey({ team: "telemetry-team" });
    tracing.exporter.reset();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", messages: [{ role: "user", content: "hi" }] },
      headers: { authorization: `Bearer ${key}` },
    });
    await app.close();
    expect(res.statusCode).toBe(200);

    const spans = tracing.exporter.getFinishedSpans();
    const upstream = spans.find(isUpstreamSpan);
    expect(upstream?.attributes).toMatchObject({
      "switchyard.team_id": team.id,
      "switchyard.key_id": record.id,
    });
    const root = spans.find((s) => s.parentSpanContext === undefined);
    expect(root?.attributes).toMatchObject({ "switchyard.team_id": team.id });

    const requests = await meters.points("switchyard_requests_total");
    expect(requests.map((p) => p.attributes)).toContainEqual({
      provider: "mock",
      model: "fast-model",
      status: "200",
      team: team.id,
      cache: "bypass",
    });
  });

  it("counts authentication failures by reason", async () => {
    const { app } = await testApp({ authenticated: false });
    await app.inject({ method: "GET", url: "/v1/models" });
    await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer nope" },
    });
    await app.close();
    const failures = await meters.points("switchyard_auth_failures_total");
    const reasons = failures.map((p) => (p.attributes as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(["missing", "malformed"]));
  });
});
