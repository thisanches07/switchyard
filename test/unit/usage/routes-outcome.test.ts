import type { AddressInfo } from "node:net";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { createLogger } from "../../../src/infra/logger.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { createMockProvider } from "../../../src/modules/providers/mock.js";
import { createOpenAiCompatibleProvider } from "../../../src/modules/providers/openai-compatible.js";
import { createOutcomeHook, registerOutcomeFallback } from "../../../src/modules/usage/outcome.js";
import { testApp } from "../../helpers/app.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";
import { captureLogs } from "../../helpers/log-capture.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { spiedRegistry } from "../../helpers/providers.js";

const messages = [{ role: "user", content: "12345678" }]; // 2 input tokens

describe("outcome hook on /v1 routes (spec 006, AC-3)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(
    options: { providers?: Map<string, ChatProvider>; store?: MemoryKeyStore } = {},
  ) {
    const events: UsageEvent[] = [];
    const { app, store } = await testApp({
      providers: options.providers ?? spiedRegistry().registry,
      ...(options.store ? { store: options.store } : {}),
      limiter: new MemoryRateLimiter(),
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    return { app, events, store };
  }

  const only = (events: UsageEvent[]) => {
    expect(events).toHaveLength(1);
    const event = events[0] as UsageEvent;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    return event;
  };

  it("records one success for a chat completion", async () => {
    const { app, events, store } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", messages },
    });
    expect(res.statusCode).toBe(200);
    const [key] = await store.listKeys();
    expect(only(events)).toMatchObject({
      requestId: res.headers["x-switchyard-request-id"],
      teamId: key?.teamId,
      keyId: key?.id,
      operation: "chat",
      stream: false,
      requestedModel: "fast",
      provider: "mock",
      servedModel: "fast-model",
      inputTokens: 2,
      outputTokens: 6,
      estimated: false,
      status: 200,
      outcome: "success",
      errorCode: null,
      ttfbMs: null,
      attempts: 1,
    });
  });

  it("records an upstream failure before the first byte", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/error-500", messages },
    });
    expect(res.statusCode).toBe(502);
    expect(only(events)).toMatchObject({
      outcome: "upstream_error",
      status: 502,
      errorCode: "upstream_error",
      requestedModel: "mock/error-500",
      servedModel: "error-500",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("records a provider 4xx passed through to the client", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/error-429", messages },
    });
    expect(res.statusCode).toBe(429);
    expect(only(events)).toMatchObject({ status: 429, errorCode: "rate_limit_exceeded" });
  });

  it("records embeddings with input tokens only", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "mock/e", input: "hello world" },
    });
    expect(res.statusCode).toBe(200);
    expect(only(events)).toMatchObject({
      operation: "embeddings",
      stream: false,
      outcome: "success",
      outputTokens: 0,
      provider: "mock",
      servedModel: "e",
    });
    expect(events[0]?.inputTokens).toBeGreaterThan(0);
  });

  it("records failed embeddings", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "mock/error-504", input: "hello" },
    });
    expect(res.statusCode).toBe(502);
    expect(only(events)).toMatchObject({ operation: "embeddings", outcome: "upstream_error" });
  });

  it("records a streamed success with an estimate when the provider reports no usage", async () => {
    const { app, events } = await setup();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", stream: true, messages },
    });
    // "This is a mock response." = 24 characters ≈ 6 tokens.
    expect(only(events)).toMatchObject({ inputTokens: 2, outputTokens: 6, estimated: true });
  });

  it("records a streamed success with TTFB", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", stream: true, stream_options: { include_usage: true }, messages },
    });
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const event = only(events);
    expect(event).toMatchObject({
      stream: true,
      outcome: "success",
      status: 200,
      inputTokens: 2,
      outputTokens: 6,
      estimated: false,
    });
    expect(event.ttfbMs).toBe(Number(res.headers["x-switchyard-ttfb-ms"]));
  });

  it("records a stream that fails before the first chunk", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/error-500", stream: true, messages },
    });
    expect(res.statusCode).toBe(502);
    expect(only(events)).toMatchObject({
      stream: true,
      outcome: "upstream_error",
      status: 502,
      ttfbMs: null,
    });
  });

  it("records a mid-stream failure with what was streamed (ADR-0008)", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/error-midstream", stream: true, messages },
    });
    expect(res.statusCode).toBe(200);
    const event = only(events);
    expect(event).toMatchObject({
      outcome: "upstream_error_midstream",
      status: 200,
      errorCode: "upstream_error",
      inputTokens: 2,
      estimated: true,
    });
    expect(event.outputTokens).toBeGreaterThan(0);
    expect(event.ttfbMs).not.toBeNull();
  });

  it("estimates usage when the provider reports none", async () => {
    const http = fakeHttp(() =>
      jsonResponse(200, {
        object: "chat.completion",
        model: "llama3.2",
        choices: [{ index: 0, message: { role: "assistant", content: "abcdefghijkl" } }],
      }),
    );
    const providers = spiedRegistry().registry;
    providers.set(
      "ollama",
      createOpenAiCompatibleProvider({ name: "ollama", baseUrl: "http://o.test" }, http.client),
    );
    const { app, events } = await setup({ providers });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "local", messages },
    });
    expect(only(events)).toMatchObject({ inputTokens: 2, outputTokens: 3, estimated: true });
  });

  it("records provider-reported prompt-cache tokens", async () => {
    const http = fakeHttp(() =>
      jsonResponse(200, {
        object: "chat.completion",
        model: "llama3.2",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      }),
    );
    const providers = spiedRegistry().registry;
    providers.set(
      "ollama",
      createOpenAiCompatibleProvider({ name: "ollama", baseUrl: "http://o.test" }, http.client),
    );
    const { app, events } = await setup({ providers });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "local", messages },
    });
    expect(only(events)).toMatchObject({ inputTokens: 100, cachedInputTokens: 64 });
  });

  it("produces no event for requests rejected before admission", async () => {
    const store = new MemoryKeyStore();
    const { app, events } = await setup({ store });
    const limited = await store.issueKey({ team: "limited", limits: { rpm: 1 } });
    const restricted = await store.issueKey({ team: "restricted", allowedModels: ["local"] });
    const post = (payload: object, authorization?: string) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload,
        ...(authorization ? { headers: { authorization } } : {}),
      });

    expect((await post({ model: "fast", messages }, "Bearer sk-sy-nope")).statusCode).toBe(401);
    expect((await post({ model: "gpt-9", messages })).statusCode).toBe(404);
    expect((await post({ model: "fast" })).statusCode).toBe(400);
    expect((await post({ model: "fast", messages }, `Bearer ${restricted.key}`)).statusCode).toBe(
      403,
    );
    expect((await post({ model: "fast", messages }, `Bearer ${limited.key}`)).statusCode).toBe(200);
    expect((await post({ model: "fast", messages }, `Bearer ${limited.key}`)).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(200);
    expect(events).toHaveLength(1); // only the admitted request
  });

  it("never puts request or response content in the event (AC-2)", async () => {
    const marker = `marker-${crypto.randomUUID()}`;
    const { app, events } = await setup();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        user: marker,
        messages: [{ role: "user", content: `please repeat ${marker}` }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", stream: true, messages: [{ role: "user", content: marker }] },
    });
    await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "mock/e", input: marker },
    });
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(marker);
  });
});

describe("client disconnects (spec 006, AC-3)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) {
      // The in-process fetch client may keep the aborted socket open; don't wait for it.
      app.server.closeAllConnections();
      await app.close();
    }
  });

  async function listening(provider: ChatProvider) {
    const events: UsageEvent[] = [];
    const providers = spiedRegistry().registry;
    providers.set("mock", provider);
    const { app, key } = await testApp({
      providers,
      authenticated: false,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return { events, url: `http://127.0.0.1:${port}/v1/chat/completions`, key };
  }

  async function waitFor(events: UsageEvent[]) {
    for (let i = 0; i < 100 && events.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50)); // a second event would arrive by now
    return events;
  }

  it("records 499 when the client leaves before a non-streaming response", async () => {
    const { events, url, key } = await listening(
      createMockProvider("mock", { latencyMs: 2_000, errorRate: 0 }),
    );
    const controller = new AbortController();
    const pending = fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/slow", messages }),
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await pending;
    const [event, ...rest] = await waitFor(events);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      outcome: "client_closed",
      status: 499,
      errorCode: null,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("records 200 with partial tokens when a stream client leaves mid-stream", async () => {
    const { events, url, key } = await listening(
      createMockProvider("mock", { latencyMs: 0, errorRate: 0, chunkDelayMs: 300 }),
    );
    const controller = new AbortController();
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/slow", stream: true, messages }),
    });
    const reader = res.body?.getReader();
    await reader?.read(); // first chunk
    controller.abort();
    const [event, ...rest] = await waitFor(events);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      outcome: "client_closed",
      status: 200,
      stream: true,
      inputTokens: 2,
      estimated: true,
    });
    expect(event?.ttfbMs).not.toBeNull();
  });
});

describe("outcome fallback (spec 006)", () => {
  it("records a tracker that a route forgot to end, and warns", async () => {
    const events: UsageEvent[] = [];
    const logs = captureLogs();
    const logger = createLogger({ level: "info", destination: logs.stream });
    const outcomes = createOutcomeHook({ recorder: { record: (e) => events.push(e) }, logger });
    const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });
    registerOutcomeFallback(app);
    const begin = (request: Parameters<typeof outcomes.begin>[0]) =>
      outcomes.begin(request, {
        requestId: "req_x",
        principal: {
          teamId: "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f",
          keyId: "0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
        },
        operation: "messages",
        stream: false,
        requestedModel: "m",
        provider: "mock",
        servedModel: "m",
        elapsedMs: () => 1,
      });
    app.get("/fails", async (request) => {
      begin(request);
      throw new GatewayError(418, "invalid_request_error", "teapot", "no");
    });
    app.get("/forgets", async (request) => {
      begin(request);
      return { ok: true };
    });
    app.get("/records", async (request) => {
      begin(request).succeed({});
      return { ok: true };
    });

    expect((await app.inject({ method: "GET", url: "/fails" })).statusCode).toBe(418);
    expect((await app.inject({ method: "GET", url: "/forgets" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/records" })).statusCode).toBe(200);
    await app.close();

    expect(events.map((e) => [e.outcome, e.status, e.errorCode])).toEqual([
      ["upstream_error", 418, "teapot"],
      ["success", 200, null],
      ["success", 200, null],
    ]);
    const warnings = logs.lines.filter((l) => l.msg === "request outcome recorded by fallback");
    expect(warnings).toHaveLength(2);
  });
});
