import { describe, expect, it } from "vitest";
import { GatewayError, upstreamError, upstreamTimeout } from "../../../src/core/errors.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { createLogger } from "../../../src/infra/logger.js";
import {
  createOutcomeHook,
  type OutcomeInit,
  type OutcomeTracker,
} from "../../../src/modules/usage/outcome.js";
import { fanOut, noopRecorder } from "../../../src/modules/usage/recorders.js";
import { captureLogs } from "../../helpers/log-capture.js";

const TEAM = "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
const KEY = "0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";

function setup(init: Partial<OutcomeInit> = {}) {
  const events: UsageEvent[] = [];
  const logs = captureLogs();
  const hook = createOutcomeHook({
    recorder: { record: (event) => events.push(event) },
    logger: createLogger({ level: "info", destination: logs.stream }),
    now: () => Date.parse("2026-10-13T23:59:59.500Z"),
  });
  const request: { outcome?: OutcomeTracker } = {};
  const tracker = hook.begin(request, {
    requestId: "req_1",
    principal: { teamId: TEAM, keyId: KEY },
    operation: "chat",
    stream: false,
    requestedModel: "fast",
    provider: "mock",
    servedModel: "fast-model",
    elapsedMs: () => 41.6,
    ...init,
  });
  return { tracker, events, request, logs: logs.lines };
}

const only = (events: UsageEvent[]) => {
  expect(events).toHaveLength(1);
  const event = events[0] as UsageEvent;
  expect(usageEventSchema.safeParse(event).success).toBe(true);
  return event;
};

describe("outcome hook (spec 006, AC-3)", () => {
  it("records a success with tokens, ids, latency and defaults", () => {
    const { tracker, events, request } = setup();
    expect(request.outcome).toBe(tracker);
    tracker.succeed({ usage: { inputTokens: 12, outputTokens: 6 } });
    expect(tracker.done).toBe(true);
    const event = only(events);
    expect(event).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      schemaVersion: 1,
      occurredAt: "2026-10-13T23:59:59.500Z",
      requestId: "req_1",
      teamId: TEAM,
      keyId: KEY,
      operation: "chat",
      stream: false,
      requestedModel: "fast",
      provider: "mock",
      servedModel: "fast-model",
      inputTokens: 12,
      outputTokens: 6,
      cachedInputTokens: 0,
      estimated: false,
      costUsd: null,
      status: 200,
      outcome: "success",
      errorCode: null,
      latencyMs: 42,
      ttfbMs: null,
      attempts: 1,
      cacheStatus: "miss",
      piiDetections: {},
    });
  });

  it("keeps provider-reported cached input tokens and stream TTFB", () => {
    const { tracker, events } = setup({ stream: true });
    tracker.succeed({
      usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 },
      estimated: true,
      ttfbMs: 12.4,
    });
    expect(only(events)).toMatchObject({
      stream: true,
      cachedInputTokens: 80,
      estimated: true,
      ttfbMs: 12,
    });
  });

  it("records an upstream failure with the status and code sent to the client", () => {
    const { tracker, events } = setup();
    tracker.fail(upstreamTimeout("mock"));
    expect(only(events)).toMatchObject({
      outcome: "upstream_error",
      status: 504,
      errorCode: "upstream_timeout",
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
      provider: "mock",
      attempts: 1,
    });
  });

  it("maps an unknown error to 500 internal_error", () => {
    const { tracker, events } = setup();
    tracker.fail(new Error("boom"));
    expect(only(events)).toMatchObject({ status: 500, errorCode: "internal_error" });
  });

  it("records a mid-stream failure as status 200 with what was streamed", () => {
    const { tracker, events } = setup({ stream: true });
    tracker.failMidstream(upstreamError("mock"), {
      usage: { inputTokens: 3, outputTokens: 4 },
      estimated: true,
      ttfbMs: 5,
    });
    expect(only(events)).toMatchObject({
      outcome: "upstream_error_midstream",
      status: 200,
      errorCode: "upstream_error",
      inputTokens: 3,
      outputTokens: 4,
      estimated: true,
      ttfbMs: 5,
    });
  });

  it.each([
    [true, 200],
    [false, 499],
  ])("records a client disconnect (headers sent: %s → status %i)", (headersSent, status) => {
    const { tracker, events } = setup();
    tracker.clientClosed({
      headersSent,
      usage: { inputTokens: 2, outputTokens: 1 },
      estimated: true,
    });
    expect(only(events)).toMatchObject({
      outcome: "client_closed",
      status,
      errorCode: null,
      inputTokens: 2,
      outputTokens: 1,
      estimated: true,
    });
  });

  it("records a client disconnect without usage as zero tokens", () => {
    const { tracker, events } = setup();
    tracker.clientClosed({ headersSent: false });
    expect(only(events)).toMatchObject({ inputTokens: 0, outputTokens: 0, estimated: false });
  });

  it("records a policy rejection without provider, attempts or tokens (spec 010)", () => {
    const { tracker, events } = setup();
    tracker.set({ piiDetections: { email: 1 } });
    tracker.reject(
      new GatewayError(400, "invalid_request_error", "pii_detected", "PII found in the request"),
    );
    expect(only(events)).toMatchObject({
      outcome: "rejected",
      status: 400,
      errorCode: "pii_detected",
      provider: null,
      servedModel: null,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      piiDetections: { email: 1 },
    });
  });

  it("applies contributions from later specs", () => {
    const { tracker, events } = setup();
    tracker.set({ attempts: 3, provider: "ollama", servedModel: "llama3.2" });
    tracker.set({ cacheStatus: "hit", costUsd: "0.0012", cachedInputTokens: 7 });
    tracker.succeed({ usage: { inputTokens: 10, outputTokens: 2 } });
    expect(only(events)).toMatchObject({
      attempts: 3,
      provider: "ollama",
      servedModel: "llama3.2",
      cacheStatus: "hit",
      costUsd: "0.0012",
      cachedInputTokens: 7,
    });
  });

  it("starts with zero attempts when no provider was resolved", () => {
    const { tracker, events } = setup({ provider: null, servedModel: null });
    tracker.succeed({});
    expect(only(events)).toMatchObject({ attempts: 0, provider: null, inputTokens: 0 });
  });

  it("records exactly one event even when several terminal paths fire", () => {
    const { tracker, events } = setup();
    tracker.succeed({ usage: { inputTokens: 1, outputTokens: 1 } });
    tracker.clientClosed({ headersSent: true });
    tracker.fail(new Error("late"));
    tracker.failMidstream(new Error("late"), {
      usage: { inputTokens: 0, outputTokens: 0 },
      estimated: true,
    });
    tracker.reject(upstreamError("mock"));
    expect(only(events).outcome).toBe("success");
  });

  it("never lets a failing recorder break the request", () => {
    const logs = captureLogs();
    const hook = createOutcomeHook({
      recorder: {
        record: () => {
          throw new Error("recorder down");
        },
      },
      logger: createLogger({ level: "info", destination: logs.stream }),
    });
    const tracker = hook.begin(
      {},
      {
        requestId: "req_2",
        principal: { teamId: TEAM, keyId: KEY },
        operation: "embeddings",
        stream: false,
        requestedModel: "mock/e",
        provider: "mock",
        servedModel: "e",
        elapsedMs: () => 1,
      },
    );
    expect(() => tracker.succeed({})).not.toThrow();
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ level: "warn", requestId: "req_2", msg: "usage recorder failed" }),
    );
  });
});

describe("recorders", () => {
  it("noopRecorder accepts events", () => {
    expect(() => noopRecorder.record({} as UsageEvent)).not.toThrow();
  });

  it("fanOut delivers to every recorder even if one throws, then rethrows", () => {
    const seen: string[] = [];
    const recorder = fanOut(
      {
        record: () => {
          throw new Error("first fails");
        },
      },
      { record: (e) => seen.push(e.requestId) },
    );
    expect(() => recorder.record({ requestId: "r" } as UsageEvent)).toThrow("first fails");
    expect(seen).toEqual(["r"]);
  });
});
