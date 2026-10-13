import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PiiMode } from "../../../src/core/pii.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

/** Every AC-3 vector (plus a deny-list term), sent through mask and block keys. */
const VECTORS = [
  "ana.silva@example.com",
  "(11) 98765-4321",
  "+55 11 98765-4321",
  "11987654321",
  "+14155552671",
  "4111 1111 1111 1111",
  "4111111111111111",
  "529.982.247-25",
  "52998224725",
  "11.222.333/0001-81",
  "11222333000181",
  "192.168.0.1",
  "2001:db8::1",
  "Project Falcon",
];
const PROMPT = `Customer data: ${VECTORS.join(" ; ")} ; end.`;

describe("original values never leave the request (spec 010, AC-12)", () => {
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

  it.each<PiiMode>(["mask", "block"])(
    "no vector appears in trace-level logs, spans or metrics (%s)",
    async (mode) => {
      tracing.exporter.reset();
      const { app, store, logs } = await testApp({
        level: "trace",
        authenticated: false,
        config: testConfig({ pii: { denyList: ["Project Falcon"] } }),
      });
      const { key } = await store.issueKey({ piiMode: mode });
      const send = (url: string, payload: object) =>
        app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${key}` } });
      const messages = [
        { role: "system", content: PROMPT },
        { role: "user", content: [{ type: "text", text: PROMPT }] },
      ];

      const responses = [
        await send("/v1/chat/completions", { model: "fast", messages }),
        await send("/v1/chat/completions", { model: "fast", messages, stream: true }),
        await send("/v1/chat/completions", { model: "mock/error-500", messages }),
        await send("/v1/embeddings", { model: "mock/e", input: [PROMPT, PROMPT] }),
      ];
      await app.close();

      const expected = mode === "block" ? [400, 400, 400, 400] : [200, 200, 502, 200];
      expect(responses.map((r) => r.statusCode)).toEqual(expected);

      const spans = tracing.exporter.getFinishedSpans();
      const points = await meters.points("switchyard_pii_detections_total");
      // The test only means something if there is telemetry to look at.
      expect(logs.length).toBeGreaterThan(4);
      expect(logs.some((line) => line.msg === "pii scan")).toBe(true);
      expect(spans.length).toBeGreaterThan(0);
      expect(points.length).toBeGreaterThan(0);

      const exported = JSON.stringify({
        logs,
        spans: spans.map((s) => ({
          name: s.name,
          attributes: s.attributes,
          events: s.events,
          status: s.status,
          links: s.links,
        })),
        metrics: points.map((p) => ({ attributes: p.attributes, value: p.value })),
      });
      for (const vector of VECTORS) {
        expect(exported, vector).not.toContain(vector);
        expect(exported.toLowerCase(), vector).not.toContain(vector.toLowerCase());
      }
      if (mode === "block") {
        for (const res of responses) {
          for (const vector of VECTORS) expect(res.body).not.toContain(vector);
        }
      }
    },
  );
});
