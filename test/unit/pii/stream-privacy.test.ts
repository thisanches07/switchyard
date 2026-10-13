import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const VALUES = [
  "ana.silva@example.com",
  "(11) 98765-4321",
  "4111 1111 1111 1111",
  "529.982.247-25",
  "11.222.333/0001-81",
  "192.168.0.1",
  "Project Falcon",
];

/** Joined `delta.content` of an OpenAI SSE body. */
const streamedText = (body: string) =>
  body
    .split("\n\n")
    .filter((e) => e.startsWith("data: {"))
    .map((e) => JSON.parse(e.slice(6)) as { choices?: { delta?: { content?: string } }[] })
    .map((e) => e.choices?.[0]?.delta?.content ?? "")
    .join("");

describe("streamed restore keeps original values in the request only (spec 015, AC-8)", () => {
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

  it("no original value appears in trace-level logs, spans or metrics; the client gets them all", async () => {
    tracing.exporter.reset();
    const { app, store, logs } = await testApp({
      level: "trace",
      authenticated: false,
      config: testConfig({
        pii: { denyList: ["Project Falcon"], streamRestore: { maxHoldMs: 60_000 } },
      }),
    });
    const { key } = await store.issueKey({ piiMode: "mask" });
    const prompts = [VALUES.join(" ; "), VALUES.join("")];
    const responses = [];
    for (const content of prompts) {
      // `mock/echo` streams the masked prompt back in pieces, splitting placeholders.
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}` },
          payload: { model: "mock/echo", stream: true, messages: [{ role: "user", content }] },
        }),
      );
    }
    await app.close();

    for (const [i, res] of responses.entries()) {
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("masked");
      expect(streamedText(res.body)).toBe(prompts[i]);
    }

    const spans = tracing.exporter.getFinishedSpans();
    const holds = await meters.points("switchyard_pii_stream_hold_seconds");
    expect(logs.length).toBeGreaterThan(4);
    expect(spans.length).toBeGreaterThan(0);
    expect(holds.length).toBeGreaterThan(0);
    expect(
      spans.some((s) => (s.attributes["switchyard.pii.stream_holds"] as number | undefined) ?? 0),
    ).toBe(true);

    const exported = JSON.stringify({
      logs,
      spans: spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
        links: s.links,
      })),
      metrics: [
        ...holds,
        ...(await meters.points("switchyard_pii_stream_restore_failures_total")),
        ...(await meters.points("switchyard_pii_detections_total")),
      ].map((p) => ({ attributes: p.attributes, value: p.value })),
    });
    for (const value of VALUES) {
      expect(exported, value).not.toContain(value);
      expect(exported.toLowerCase(), value).not.toContain(value.toLowerCase());
    }
  });
});
