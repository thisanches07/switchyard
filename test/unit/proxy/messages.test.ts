import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HttpStreamResponse } from "../../../src/core/provider.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { createProviderRegistry } from "../../../src/modules/providers/registry.js";
import { fixtureJson, fixtureText } from "../../helpers/anthropic-fixtures.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const hi = { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

function sseResponse(text: string): HttpStreamResponse {
  return {
    status: 200,
    headers: { "request-id": "req_upstream" },
    text: async () => text,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}

/** Parses an Anthropic SSE body into `{event, data}` pairs. */
const events = (body: string) =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "null";
      return {
        event: lines.find((l) => l.startsWith("event: "))?.slice(7),
        data: JSON.parse(data) as Record<string, unknown>,
      };
    });

describe("POST /v1/messages (spec 014)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  /** App whose `claude` provider is the real adapter on a scripted fake HTTP client. */
  async function setup(
    options: { message?: unknown; stream?: string; store?: MemoryKeyStore } = {},
  ) {
    const config = testConfig();
    const http = fakeHttp(
      () => jsonResponse(200, options.message ?? fixtureJson("message-thinking.json")),
      () => sseResponse(options.stream ?? fixtureText("stream-thinking.sse")),
    );
    const providers = createProviderRegistry(
      config,
      { ANTHROPIC_API_KEY: "sk-ant" },
      { http: http.client },
    );
    const store = options.store ?? new MemoryKeyStore();
    const { app, key } = await testApp({ config, providers, store, authenticated: false });
    apps.push(app);
    const send = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: payload as object,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", ...headers },
      });
    return { app, key, http, send, store };
  }

  describe("cross-family (mock provider, AC-8/AC-11)", () => {
    it("returns an Anthropic message with the requested model, ids and headers", async () => {
      const { send } = await setup();
      const res = await send(hi);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: expect.stringMatching(/^msg_/),
        type: "message",
        role: "assistant",
        model: "fast",
        content: [{ type: "text", text: "This is a mock response." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 6,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
      expect(res.headers["x-switchyard-provider"]).toBe("mock");
      expect(res.headers["request-id"]).toBe(res.headers["x-switchyard-request-id"]);
    });

    it("streams Anthropic SSE synthesised from canonical chunks, without [DONE]", async () => {
      const { send } = await setup();
      const res = await send({ ...hi, stream: true });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
      const parsed = events(res.body);
      expect(parsed.map((e) => e.event)).toEqual([
        "message_start",
        "content_block_start",
        ...Array(5).fill("content_block_delta"),
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      const text = parsed
        .map((e) => (e.data.delta as { text?: string } | undefined)?.text ?? "")
        .join("");
      expect(text).toBe("This is a mock response.");
      expect(parsed.at(-2)?.data).toMatchObject({
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 6 },
      });
      expect(res.body).not.toContain("[DONE]");
    });

    it("rejects documents and server tools with 400 naming the field", async () => {
      const { send } = await setup();
      const res = await send({
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
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.type).toBe("invalid_request_error");
      expect(res.json().error.message).toContain("messages[0].content[0]");
      expect(res.json().error.message).toContain("tools[0]");
    });

    it("ends a failing stream with one Anthropic error event (AC-12)", async () => {
      const { send } = await setup();
      const res = await send({ ...hi, model: "mock/error-midstream", stream: true });
      expect(res.statusCode).toBe(200);
      const parsed = events(res.body);
      expect(parsed.at(-1)).toEqual({
        event: "error",
        data: { type: "error", error: { type: "api_error", message: expect.any(String) } },
      });
      expect(parsed.some((e) => e.event === "message_stop")).toBe(false);
    });
  });

  describe("same-family (anthropic provider, AC-7/AC-11)", () => {
    const claudeRequest = () => ({
      ...(JSON.parse(fixtureText("request-same-family.json")) as Record<string, unknown>),
      model: "claude/claude-sonnet-5-5",
    });

    it("sends the client body natively and returns the upstream message with the requested model", async () => {
      const { send, http } = await setup();
      const body = claudeRequest();
      const res = await send(body, { "anthropic-beta": "beta-1" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ...fixtureJson("message-thinking.json"),
        model: "claude/claude-sonnet-5-5",
      });
      expect(JSON.stringify(http.calls[0]?.body)).toBe(
        JSON.stringify({ ...body, model: "claude-sonnet-5-5" }),
      );
      expect(http.calls[0]?.headers["anthropic-beta"]).toBe("beta-1");
      expect(res.headers["x-switchyard-provider"]).toBe("claude");
    });

    it("forwards upstream SSE events unchanged except the model", async () => {
      const { send } = await setup();
      const res = await send({ ...claudeRequest(), stream: true });
      expect(res.statusCode).toBe(200);
      const expected = fixtureText("stream-thinking.sse").replace(
        '"model": "claude-sonnet-5-5"',
        '"model": "claude/claude-sonnet-5-5"',
      );
      expect(events(res.body)).toEqual(events(expected));
      expect(res.body).toContain("signature_delta");
    });

    it("does not forward anthropic-beta to other providers", async () => {
      const { send, http } = await setup();
      await send(hi, { "anthropic-beta": "beta-1" });
      expect(http.calls).toHaveLength(0);
    });
  });

  describe("errors in the Anthropic shape (AC-14)", () => {
    const expectAnthropicError = (
      res: {
        statusCode: number;
        headers: Record<string, unknown>;
        json(): Record<string, unknown>;
      },
      status: number,
      type: string,
      code: string,
    ) => {
      expect(res.statusCode).toBe(status);
      const requestId = res.headers["x-switchyard-request-id"];
      expect(res.json()).toEqual({
        type: "error",
        error: { type, message: expect.any(String), details: { error_code: code } },
        request_id: requestId,
      });
      expect(res.headers["request-id"]).toBe(requestId);
    };

    it.each([
      [
        { "x-api-key": "sk-sy-unknown0000000000000000000000000000000000" },
        hi,
        401,
        "authentication_error",
        "invalid_api_key",
      ],
      [{}, { model: "fast", messages: [] }, 400, "invalid_request_error", "invalid_request"],
      [{}, { ...hi, model: "gpt-9" }, 404, "not_found_error", "model_not_found"],
      [{}, { ...hi, model: "mock/error-500" }, 502, "api_error", "upstream_error"],
      [{}, { ...hi, model: "mock/error-429" }, 429, "rate_limit_error", "rate_limit_exceeded"],
      [{}, { ...hi, model: "mock/error-500", stream: true }, 502, "api_error", "upstream_error"],
    ])("%j %j → %i %s", async (headers, payload, status, type, code) => {
      const { send } = await setup();
      expectAnthropicError(await send(payload, headers), status, type, code);
    });

    it("403 model_not_allowed → permission_error", async () => {
      const store = new MemoryKeyStore();
      const { key } = await store.issueKey({ allowedModels: ["local"] });
      const { send } = await setup({ store });
      expectAnthropicError(
        await send(hi, { "x-api-key": key }),
        403,
        "permission_error",
        "model_not_allowed",
      );
    });

    it("invalid JSON → 400 invalid_request_error", async () => {
      const { app, key } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: "{nope",
        headers: { "x-api-key": key, "content-type": "application/json" },
      });
      expectAnthropicError(res, 400, "invalid_request_error", "invalid_json");
    });

    it("keeps the OpenAI shape on /v1/chat/completions", async () => {
      const { app, key } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "gpt-9", messages: [{ role: "user", content: "x" }] },
        headers: { "x-api-key": key },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: {
          message: expect.any(String),
          type: "invalid_request_error",
          code: "model_not_found",
        },
      });
      expect(res.headers["request-id"]).toBeUndefined();
    });
  });

  describe("rate limits (AC-9)", () => {
    it("sends anthropic-ratelimit-* on success and on 429, plus retry-after", async () => {
      const store = new MemoryKeyStore();
      const { key } = await store.issueKey({ team: "limited", limits: { rpm: 1 } });
      const { app } = await testApp({
        store,
        limiter: new MemoryRateLimiter(),
        authenticated: false,
      });
      apps.push(app);
      const send = () =>
        app.inject({
          method: "POST",
          url: "/v1/messages",
          payload: hi,
          headers: { "x-api-key": key },
        });

      const ok = await send();
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["anthropic-ratelimit-requests-limit"]).toBe("1");
      expect(ok.headers["anthropic-ratelimit-requests-remaining"]).toBe("0");
      expect(ok.headers["anthropic-ratelimit-requests-reset"]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(ok.headers["x-ratelimit-limit-requests"]).toBe("1");

      const limited = await send();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.type).toBe("rate_limit_error");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(limited.headers["anthropic-ratelimit-requests-remaining"]).toBe("0");
      expect(limited.headers["x-ratelimit-remaining-requests"]).toBe("0");
    });

    it("uses max_tokens as the completion allowance", async () => {
      const store = new MemoryKeyStore();
      const { key } = await store.issueKey({ team: "tpm", limits: { tpm: 100 } });
      const { app } = await testApp({ store, authenticated: false });
      apps.push(app);
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: { ...hi, max_tokens: 500 },
        headers: { "x-api-key": key },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.error_code).toBe("request_too_large_for_limit");
    });
  });
});

describe("POST /v1/messages request span (AC-9)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  beforeAll(() => {
    tracing = installInMemoryTracing();
  });
  afterAll(async () => {
    await tracing.uninstall();
  });

  it("tags the request span with gen_ai.operation.name=chat and switchyard.api=anthropic, no content", async () => {
    const { app } = await testApp();
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { ...hi, messages: [{ role: "user", content: "secret-prompt" }] },
    });
    await app.close();
    const spans = tracing.exporter.getFinishedSpans();
    const request = spans.find((s) => s.attributes["switchyard.api"] === "anthropic");
    expect(request?.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("secret-prompt");
  });
});
