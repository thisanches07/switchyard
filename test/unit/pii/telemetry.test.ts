import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PiiMode } from "../../../src/core/pii.js";
import { testApp } from "../../helpers/app.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const CPF = "529.982.247-25";

describe("PII telemetry (spec 010, AC-13)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  let meters: ReturnType<typeof installTestMetrics>;
  const apps: { close(): Promise<unknown> }[] = [];
  beforeAll(() => {
    tracing = installInMemoryTracing();
    meters = installTestMetrics();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  afterAll(async () => {
    await tracing.uninstall();
    await meters.uninstall();
  });

  async function send(mode: PiiMode, url: string, payload: object) {
    const { app, store } = await testApp({ authenticated: false });
    apps.push(app);
    const { key } = await store.issueKey({ team: `pii-${mode}`, piiMode: mode });
    tracing.exporter.reset();
    const res = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { authorization: `Bearer ${key}` },
    });
    const root = tracing.exporter
      .getFinishedSpans()
      .find((s: ReadableSpan) => s.parentSpanContext === undefined);
    return { res, attributes: root?.attributes ?? {} };
  }

  const chat = (content: string) => ({
    model: "fast",
    messages: [{ role: "user", content }],
  });

  it("counts detections per type and tags the request span when masking", async () => {
    const before = await meters.points("switchyard_pii_detections_total");
    const { res, attributes } = await send(
      "mask",
      "/v1/chat/completions",
      chat(`${CPF} and ${CPF}, mail ana@example.com`),
    );
    expect(res.statusCode).toBe(200);
    expect(attributes).toMatchObject({
      "switchyard.pii.mode": "mask",
      "switchyard.pii.action": "masked",
      "switchyard.pii.detections": 3,
    });
    expect(attributes).not.toHaveProperty("switchyard.pii.uninspected");

    const after = await meters.points("switchyard_pii_detections_total");
    const value = (points: typeof after, type: string) =>
      Number(points.find((p) => p.attributes.type === type)?.value ?? 0);
    expect(value(after, "cpf") - value(before, "cpf")).toBe(2);
    expect(value(after, "email") - value(before, "email")).toBe(1);
    expect(after.every((p) => Object.keys(p.attributes).join() === "type")).toBe(true);
  });

  it("tags blocked requests", async () => {
    const { res, attributes } = await send("block", "/v1/chat/completions", chat(CPF));
    expect(res.statusCode).toBe(400);
    expect(attributes).toMatchObject({
      "switchyard.pii.mode": "block",
      "switchyard.pii.action": "blocked",
      "switchyard.pii.detections": 1,
    });
  });

  it("tags clean requests with action none and zero detections", async () => {
    const { attributes } = await send("mask", "/v1/chat/completions", chat("hello"));
    expect(attributes).toMatchObject({
      "switchyard.pii.action": "none",
      "switchyard.pii.detections": 0,
    });
  });

  it("flags token-array embeddings input as uninspected", async () => {
    const { res, attributes } = await send("block", "/v1/embeddings", {
      model: "mock/e",
      input: [[1, 2, 3]],
    });
    expect(res.statusCode).toBe(200);
    expect(attributes).toMatchObject({
      "switchyard.pii.action": "none",
      "switchyard.pii.uninspected": true,
    });
  });

  it("adds nothing when the mode is off", async () => {
    const { attributes } = await send("off", "/v1/chat/completions", chat(CPF));
    expect(Object.keys(attributes).filter((k) => k.startsWith("switchyard.pii"))).toEqual([]);
  });
});
