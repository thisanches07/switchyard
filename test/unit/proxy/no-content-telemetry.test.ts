import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testApp } from "../../helpers/app.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

/** A string that only ever appears in prompts (and in what the echo model answers). */
const SENTINEL = "zx-sentinel-7d1f-content";
const CONTENT_ATTRIBUTES = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
];

describe("no prompt or response content in telemetry (spec 011, AC-5, ADR-0010)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;

  beforeAll(() => {
    // Instrumentations that honour this variable would capture content; the gateway must not.
    vi.stubEnv("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "true");
    tracing = installInMemoryTracing();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await tracing.uninstall();
  });

  it("keeps the sentinel out of every span attribute, span event and log line", async () => {
    const { app, logs } = await testApp({ level: "debug" });
    const user = { role: "user", content: `please repeat ${SENTINEL}` };
    const system = { role: "system", content: `system says ${SENTINEL}` };
    const requests = [
      { url: "/v1/chat/completions", payload: { model: "mock/echo", messages: [system, user] } },
      {
        url: "/v1/chat/completions",
        payload: { model: "mock/echo", stream: true, messages: [user] },
      },
      { url: "/v1/chat/completions", payload: { model: "mock/error-500", messages: [user] } },
      { url: "/v1/embeddings", payload: { model: "mock/embed", input: SENTINEL } },
      {
        url: "/v1/messages",
        payload: {
          model: "mock/echo",
          max_tokens: 50,
          system: SENTINEL,
          messages: [{ role: "user", content: SENTINEL }],
        },
      },
    ];
    for (const { url, payload } of requests) {
      const res = await app.inject({ method: "POST", url, payload });
      // The echo model proves the content did go through the gateway (streams split it).
      if (payload.model === "mock/echo" && !("stream" in payload)) {
        expect(res.body).toContain(SENTINEL);
      }
    }
    await app.close();

    const spans = tracing.exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(requests.length);
    for (const span of spans) {
      const recorded = JSON.stringify({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      });
      expect(recorded, span.name).not.toContain(SENTINEL);
      for (const key of CONTENT_ATTRIBUTES) expect(span.attributes).not.toHaveProperty(key);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });
});
