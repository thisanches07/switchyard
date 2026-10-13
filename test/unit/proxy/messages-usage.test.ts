/**
 * `/v1/messages` with spec 006's outcome hook and spec 010's PII stage (spec 014, T18):
 * one usage event per admitted request with `operation: "messages"`, provider-reported
 * prompt-cache tokens, and PII masking on both the cross-family and the same-family path.
 */
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PiiMode } from "../../../src/core/pii.js";
import type { HttpStreamResponse } from "../../../src/core/provider.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { createMockProvider } from "../../../src/modules/providers/mock.js";
import { createProviderRegistry } from "../../../src/modules/providers/registry.js";
import { fixtureJson, fixtureText } from "../../helpers/anthropic-fixtures.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";

const EMAIL = "ana.silva@example.com";
const hi = { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "12345678" }] };

function sseResponse(text: string): HttpStreamResponse {
  return {
    status: 200,
    text: async () => text,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}

describe("/v1/messages usage events and PII (spec 014 with specs 006 and 010)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  async function setup(
    options: { mode?: PiiMode; message?: unknown; stream?: string; slowMock?: boolean } = {},
  ) {
    const events: UsageEvent[] = [];
    const config = testConfig();
    const http = fakeHttp(
      () => jsonResponse(200, options.message ?? fixtureJson("message-text.json")),
      () => sseResponse(options.stream ?? fixtureText("stream-text.sse")),
    );
    const providers = new Map(
      createProviderRegistry(config, { ANTHROPIC_API_KEY: "sk-ant" }, { http: http.client }),
    );
    if (options.slowMock) {
      providers.set(
        "mock",
        createMockProvider("mock", { latencyMs: 0, errorRate: 0, chunkDelayMs: 300 }),
      );
    }
    const { app, store } = await testApp({
      config,
      providers,
      limiter: new MemoryRateLimiter(),
      authenticated: false,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    const { key } = await store.issueKey({
      team: "messages-usage",
      piiMode: options.mode ?? "off",
    });
    const send = (payload: object) =>
      app.inject({ method: "POST", url: "/v1/messages", payload, headers: { "x-api-key": key } });
    return { app, key, events, http, send };
  }

  const only = (events: UsageEvent[]) => {
    expect(events).toHaveLength(1);
    const event = events[0] as UsageEvent;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    expect(JSON.stringify(event)).not.toContain(EMAIL);
    return event;
  };

  describe("outcome hook (AC-9)", () => {
    it("records one success with operation messages (cross-family)", async () => {
      const { events, send } = await setup();
      const res = await send(hi);
      expect(res.statusCode).toBe(200);
      expect(only(events)).toMatchObject({
        requestId: res.headers["x-switchyard-request-id"],
        operation: "messages",
        stream: false,
        requestedModel: "fast",
        provider: "mock",
        servedModel: "fast-model",
        inputTokens: 2,
        outputTokens: 6,
        outcome: "success",
        status: 200,
      });
    });

    it("records provider prompt-cache reads as cachedInputTokens (same-family)", async () => {
      const { events, send } = await setup();
      const res = await send({ ...hi, model: "claude/claude-sonnet-5-5" });
      expect(res.statusCode).toBe(200);
      expect(only(events)).toMatchObject({
        operation: "messages",
        provider: "claude",
        servedModel: "claude-sonnet-5-5",
        inputTokens: 3995,
        outputTokens: 503,
        cachedInputTokens: 1800,
        estimated: false,
      });
    });

    it("records cachedInputTokens for a same-family stream", async () => {
      const { events, send } = await setup();
      const res = await send({ ...hi, model: "claude/claude-sonnet-5-5", stream: true });
      expect(res.statusCode).toBe(200);
      expect(only(events)).toMatchObject({
        operation: "messages",
        stream: true,
        outcome: "success",
        inputTokens: 35,
        outputTokens: 15,
        cachedInputTokens: 10,
      });
    });

    it("records cachedInputTokens for /v1/chat/completions routed to anthropic", async () => {
      const { app, key, events } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "claude/claude-sonnet-5-5", messages: [{ role: "user", content: "x" }] },
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(200);
      expect(only(events)).toMatchObject({ operation: "chat", cachedInputTokens: 1800 });
    });

    it("records a cross-family stream success", async () => {
      const { events, send } = await setup();
      expect((await send({ ...hi, stream: true })).statusCode).toBe(200);
      expect(only(events)).toMatchObject({
        operation: "messages",
        stream: true,
        outcome: "success",
        outputTokens: 6,
      });
    });

    it("records a failure before the first byte", async () => {
      const { events, send } = await setup();
      const res = await send({ ...hi, model: "mock/error-500", stream: true });
      expect(res.statusCode).toBe(502);
      expect(only(events)).toMatchObject({
        operation: "messages",
        outcome: "upstream_error",
        status: 502,
        errorCode: "upstream_error",
      });
    });

    it("records a mid-stream failure", async () => {
      const { events, send } = await setup();
      const res = await send({ ...hi, model: "mock/error-midstream", stream: true });
      expect(res.statusCode).toBe(200);
      expect(only(events)).toMatchObject({
        operation: "messages",
        outcome: "upstream_error_midstream",
        status: 200,
      });
    });

    it("records no event for requests refused before admission", async () => {
      const { events, send } = await setup();
      expect((await send({ ...hi, model: "gpt-9" })).statusCode).toBe(404);
      expect(events).toHaveLength(0);
    });

    it("records client_closed when a stream client leaves mid-stream", async () => {
      const { app, key, events } = await setup({ slowMock: true });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ ...hi, model: "mock/slow", stream: true }),
      });
      const reader = res.body?.getReader();
      await reader?.read(); // message_start
      controller.abort();
      for (let i = 0; i < 100 && events.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(only(events)).toMatchObject({
        operation: "messages",
        outcome: "client_closed",
        status: 200,
        stream: true,
      });
    });
  });

  describe("PII stage (spec 010 on /v1/messages)", () => {
    it("masks cross-family requests and restores the non-streaming answer", async () => {
      const { events, send } = await setup({ mode: "mask" });
      const res = await send({
        ...hi,
        model: "mock/echo",
        system: `Reply to ${EMAIL}`,
        messages: [{ role: "user", content: `Write to ${EMAIL}` }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("masked");
      // The echo mock answers with what it received (the placeholder); the client gets the value.
      expect(res.json().content).toEqual([{ type: "text", text: `Write to ${EMAIL}` }]);
      expect(only(events)).toMatchObject({ operation: "messages", piiDetections: { email: 2 } });
    });

    it("forwards masked text natively on the same-family path and restores the message", async () => {
      const upstream = {
        ...fixtureJson<Record<string, unknown>>("message-text.json"),
        content: [
          { type: "thinking", thinking: "I will write to <EMAIL_1>.", signature: "sig" },
          { type: "text", text: "Sent to <EMAIL_1>." },
          { type: "tool_use", id: "toolu_1", name: "send", input: { to: "<EMAIL_1>" } },
        ],
      };
      const { events, send, http } = await setup({ mode: "mask", message: upstream });
      const thinking = { type: "thinking", thinking: `Earlier: ${EMAIL}`, signature: "s1" };
      const res = await send({
        model: "claude/claude-sonnet-5-5",
        max_tokens: 100,
        system: [{ type: "text", text: `Owner ${EMAIL}`, cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: `Mail ${EMAIL}` }] },
          {
            role: "assistant",
            content: [
              thinking,
              { type: "tool_use", id: "toolu_0", name: "send", input: { to: EMAIL } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_0", content: `ok ${EMAIL}` }],
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      const sent = http.calls[0]?.body as {
        system: Record<string, unknown>[];
        messages: { content: Record<string, unknown>[] }[];
      };
      expect(sent.system[0]).toEqual({
        type: "text",
        text: "Owner <EMAIL_1>",
        cache_control: { type: "ephemeral" },
      });
      expect(sent.messages[0]?.content[0]).toEqual({ type: "text", text: "Mail <EMAIL_1>" });
      expect(sent.messages[1]?.content[1]).toMatchObject({ input: { to: "<EMAIL_1>" } });
      expect(sent.messages[2]?.content[0]).toMatchObject({ content: "ok <EMAIL_1>" });
      // Thinking blocks are signed and opaque: forwarded untouched (ADR-0016).
      expect(sent.messages[1]?.content[0]).toEqual(thinking);

      const message = res.json() as { content: Record<string, unknown>[]; model: string };
      expect(message.model).toBe("claude/claude-sonnet-5-5");
      expect(message.content[1]).toEqual({ type: "text", text: `Sent to ${EMAIL}.` });
      expect(message.content[2]).toMatchObject({ input: { to: EMAIL } });
      expect(message.content[0]).toEqual(upstream.content[0]);
      expect(only(events)).toMatchObject({ provider: "claude", piiDetections: { email: 4 } });
    });

    it("restores cross-family streams (spec 015)", async () => {
      const { send } = await setup({ mode: "mask" });
      const res = await send({
        ...hi,
        model: "mock/echo",
        messages: [{ role: "user", content: `Write to ${EMAIL}` }],
        stream: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("masked");
      const text = res.body
        .split("\n\n")
        .filter((e) => e.includes("text_delta"))
        .map((e) => JSON.parse(e.slice(e.indexOf("data: ") + 6)).delta.text)
        .join("");
      expect(text).toBe(`Write to ${EMAIL}`);
      expect(res.body).not.toContain("<EMAIL");
    });

    it("leaves same-family (native) streams unrestored and says so (spec 015 non-goal)", async () => {
      const upstream = fixtureText("stream-text.sse").replace('"Hello"', '"Hi <EMAIL_1>"');
      expect(upstream).toContain("<EMAIL_1>");
      const { send } = await setup({ mode: "mask", stream: upstream });
      const res = await send({
        ...hi,
        model: "claude/claude-sonnet-5-5",
        messages: [{ role: "user", content: EMAIL }],
        stream: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("masked-unrestored");
      expect(res.body).toContain("<EMAIL_1>");
      expect(res.body).not.toContain(EMAIL);
    });

    it("block mode → Anthropic-shaped 400 pii_detected and one rejected event", async () => {
      const { events, send, http } = await setup({ mode: "block" });
      const res = await send({
        ...hi,
        model: "claude/claude-sonnet-5-5",
        messages: [{ role: "user", content: `Mail ${EMAIL}` }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        type: "error",
        error: { type: "invalid_request_error", details: { error_code: "pii_detected" } },
      });
      expect(http.calls).toHaveLength(0);
      expect(only(events)).toMatchObject({
        operation: "messages",
        outcome: "rejected",
        provider: null,
        attempts: 0,
        errorCode: "pii_detected",
        piiDetections: { email: 1 },
      });
    });

    it("mode off keeps the same-family body byte for byte", async () => {
      const { send, http } = await setup({ mode: "off" });
      const body = {
        ...(JSON.parse(fixtureText("request-same-family.json")) as Record<string, unknown>),
        model: "claude/claude-sonnet-5-5",
      };
      expect((await send(body)).statusCode).toBe(200);
      expect(JSON.stringify(http.calls[0]?.body)).toBe(
        JSON.stringify({ ...body, model: "claude-sonnet-5-5" }),
      );
    });
  });
});
