import type { DataPoint } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "../../../src/core/usage.js";
import { usageMetrics } from "../../../src/modules/usage/telemetry.js";
import { tokenMetricsRecorder } from "../../../src/modules/usage/token-metrics.js";
import { testApp } from "../../helpers/app.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { spiedRegistry } from "../../helpers/providers.js";

describe("switchyard_tokens_total (spec 011, AC-3)", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    meters = installTestMetrics();
  });
  afterEach(async () => {
    await meters.uninstall();
  });

  const total = (points: DataPoint<unknown>[], direction: string) =>
    points
      .filter((p) => p.attributes.direction === direction)
      .reduce((sum, p) => sum + Number(p.value), 0);

  it("matches the input and output tokens of the usage events of the same requests", async () => {
    const events: UsageEvent[] = [];
    const { app } = await testApp({
      providers: spiedRegistry().registry,
      usageRecorder: { record: (event) => events.push(event) },
    });
    const chat = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { messages: [{ role: "user", content: "count my tokens" }], ...payload },
      });
    await chat({ model: "fast" });
    await chat({ model: "mock/echo", stream: true });
    await chat({ model: "mock/error-500" });
    await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "mock/embed", input: ["one", "two"] },
    });
    await app.close();

    expect(events).toHaveLength(4);
    const points = await meters.points("switchyard_tokens_total");
    const input = events.reduce((sum, e) => sum + e.inputTokens, 0);
    const output = events.reduce((sum, e) => sum + e.outputTokens, 0);
    expect(input).toBeGreaterThan(0);
    expect(output).toBeGreaterThan(0);
    expect(total(points, "input")).toBe(input);
    expect(total(points, "output")).toBe(output);
    expect(points.map((p) => p.attributes)).toContainEqual({
      direction: "output",
      provider: "mock",
      model: "fast-model",
    });
  });

  it("labels events without an upstream as provider and model none, and skips zeros", async () => {
    const event = {
      inputTokens: 5,
      outputTokens: 0,
      provider: null,
      servedModel: null,
    } as unknown as UsageEvent;
    tokenMetricsRecorder.record(event);
    const points = await meters.points("switchyard_tokens_total");
    expect(points.map((p) => [p.attributes, p.value])).toEqual([
      [{ direction: "input", provider: "none", model: "none" }, 5],
    ]);
  });
});

describe("switchyard_usage_events_dropped_total series (spec 011, AC-9)", () => {
  it("exists at 0 for every reason before the first drop", async () => {
    const meters = installTestMetrics();
    const unwatch = usageMetrics.watchBuffer(() => 0);
    const points = await meters.points("switchyard_usage_events_dropped_total");
    unwatch();
    await meters.uninstall();
    expect(points.map((p) => [p.attributes.reason, p.value]).sort()).toEqual([
      ["buffer_full", 0],
      ["invalid", 0],
      ["shutdown", 0],
    ]);
  });
});
