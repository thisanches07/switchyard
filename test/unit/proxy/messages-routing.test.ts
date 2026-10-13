import { afterEach, describe, expect, it } from "vitest";
import type { HttpStreamResponse } from "../../../src/core/provider.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { createProviderRegistry } from "../../../src/modules/providers/registry.js";
import { fixtureJson, fixtureText } from "../../helpers/anthropic-fixtures.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";

const hi = { max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
const withDocument = {
  ...hi,
  messages: [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "text", media_type: "text/plain", data: "x" } },
        { type: "text", text: "summarise" },
      ],
    },
  ],
};

function sseResponse(text: string): HttpStreamResponse {
  return {
    status: 200,
    text: async () => text,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}

describe("routing on POST /v1/messages (spec 008)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  /** `mock` is the mock provider; `claude` the real Anthropic adapter on a fake HTTP client. */
  async function setup() {
    const config = testConfig({
      aliases: {
        resilient: { strategy: "priority", candidates: ["mock/error-503", "mock/answer"] },
        mixed: { strategy: "priority", candidates: ["mock/answer", "claude/claude-sonnet-5-5"] },
        mockonly: { strategy: "priority", candidates: ["mock/a", "mock/b"] },
      },
    });
    const http = fakeHttp(
      () => jsonResponse(200, fixtureJson("message-text.json")),
      () => sseResponse(fixtureText("stream-text.sse")),
    );
    const providers = createProviderRegistry(
      config,
      { ANTHROPIC_API_KEY: "sk-ant" },
      { http: http.client },
    );
    const events: UsageEvent[] = [];
    const { app } = await testApp({
      config,
      providers,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    const send = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: payload as object,
        headers: { "anthropic-version": "2023-06-01" },
      });
    return { send, http, events };
  }

  const lastEvent = (events: UsageEvent[]) => {
    const event = events.at(-1) as UsageEvent;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    return event;
  };

  it("falls back before answering (AC-3, AC-10)", async () => {
    const { send, events } = await setup();
    const res = await send({ ...hi, model: "resilient" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "message", model: "resilient" });
    expect(res.headers["x-switchyard-model"]).toBe("answer");
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    expect(lastEvent(events)).toMatchObject({
      operation: "messages",
      attempts: 2,
      servedModel: "answer",
    });
  });

  it("falls back before the first event of a stream (AC-6)", async () => {
    const { send } = await setup();
    const res = await send({ ...hi, model: "resilient", stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    expect(res.body).toContain("event: message_start");
    expect(res.body).toContain("event: message_stop");
  });

  it("sends Anthropic-only content to the anthropic candidates of a mixed alias", async () => {
    const { send, http } = await setup();
    const res = await send({ ...withDocument, model: "mixed" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-provider"]).toBe("claude");
    expect(res.headers["x-switchyard-attempts"]).toBe("1");
    expect(http.calls).toHaveLength(1);
  });

  it("without Anthropic-only content the alias keeps its order", async () => {
    const { send, http } = await setup();
    const res = await send({ ...hi, model: "mixed" });
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(http.calls).toHaveLength(0);
  });

  it("400 naming the content when no anthropic candidate is left", async () => {
    const { send } = await setup();
    const res = await send({ ...withDocument, model: "mockonly" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(res.json().error.message).toContain("messages[0].content[0]");
  });

  it("answers no_healthy_upstream in the Anthropic shape (AC-9)", async () => {
    const { send } = await setup();
    // Open mock/error-503 (10 consecutive failures by default: four requests of 3 attempts).
    for (let i = 0; i < 4; i += 1) await send({ ...hi, model: "mock/error-503" });
    const res = await send({ ...hi, model: "mock/error-503" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "overloaded_error" } });
    expect(res.headers["x-switchyard-attempts"]).toBe("0");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});
