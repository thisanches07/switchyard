import type { Histogram } from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SpanAnnotator, streamHoldRecorder } from "../../../src/modules/pii/telemetry.js";
import { installTestMetrics } from "../../helpers/metrics.js";

/** An annotator that keeps the attributes set through it. */
function spanStub() {
  const attributes: Record<string, unknown> = {};
  const span: SpanAnnotator = (attrs) => Object.assign(attributes, attrs);
  return { span, attributes };
}

describe("stream restore telemetry (spec 015, AC-5)", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeAll(() => {
    meters = installTestMetrics();
  });
  afterAll(async () => {
    await meters.uninstall();
  });

  it("records every hold and counts only limit releases as failures", async () => {
    const { span, attributes } = spanStub();
    const record = streamHoldRecorder(span);
    record({ heldMs: 20, outcome: "restored" });
    record({ heldMs: 0, outcome: "ruled_out" });
    record({ heldMs: 250, outcome: "hold_limit" });
    record({ heldMs: 5, outcome: "end" });

    const [hold] = await meters.points("switchyard_pii_stream_hold_seconds");
    const histogram = hold?.value as Histogram;
    expect(histogram.count).toBe(4);
    expect(histogram.sum).toBeCloseTo(0.275, 6);
    expect(hold?.attributes).toEqual({});

    const failures = await meters.points("switchyard_pii_stream_restore_failures_total");
    expect(failures.map((p) => ({ attributes: p.attributes, value: p.value }))).toEqual([
      { attributes: { reason: "hold_limit" }, value: 1 },
    ]);
    expect(attributes).toEqual({
      "switchyard.pii.stream_holds": 4,
      "switchyard.pii.stream_restore_failures": 1,
    });
  });

  it("works without a span", () => {
    expect(() => streamHoldRecorder(undefined)({ heldMs: 1, outcome: "hold_limit" })).not.toThrow();
  });
});
