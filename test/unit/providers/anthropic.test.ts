import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatChunk } from "../../../src/core/chat.js";
import { GatewayError } from "../../../src/core/errors.js";
import {
  type HttpStreamResponse,
  UpstreamNetworkError,
  UpstreamTimeoutError,
} from "../../../src/core/provider.js";
import { createAnthropicProvider } from "../../../src/modules/providers/anthropic.js";
import { fixtureJson, fixtureText } from "../../helpers/anthropic-fixtures.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const config = {
  name: "claude",
  baseUrl: "https://api.anthropic.test/",
  apiKey: "sk-ant-test",
  defaultMaxTokens: 1024,
};
const request = {
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.2,
};
const ctx = () => ({ signal: new AbortController().signal });

function sseResponse(
  status: number,
  parts: (string | Error)[],
  headers: Record<string, string> = {},
): HttpStreamResponse {
  return {
    status,
    headers,
    text: async () => parts.filter((p) => typeof p === "string").join(""),
    body: (async function* () {
      for (const part of parts) {
        if (part instanceof Error) throw part;
        yield new TextEncoder().encode(part);
      }
    })(),
  };
}

async function gatewayError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected GatewayError");
}

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  let error: unknown;
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } catch (e) {
    error = e;
  }
  return { chunks, error };
}

describe("anthropic provider (spec 014)", () => {
  it("AC-1: posts to {baseUrl}/v1/messages with x-api-key and anthropic-version", async () => {
    const http = fakeHttp(() => jsonResponse(200, fixtureJson("message-text.json")));
    const provider = createAnthropicProvider(config, http.client);
    const result = await provider.chat(request, ctx());

    expect(provider.type).toBe("anthropic");
    expect(http.calls[0]?.url).toBe("https://api.anthropic.test/v1/messages");
    expect(http.calls[0]?.headers).toEqual({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(http.calls[0]?.body).toEqual({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1024,
      temperature: 0.2,
    });
    expect(result.body).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hi! My name is Claude." }, finish_reason: "stop" }],
    });
    expect(result.usage).toEqual({ inputTokens: 3995, outputTokens: 503, cachedInputTokens: 1800 });
    expect(result.responseModel).toBe("claude-sonnet-5-5");
    expect(result.native).toBeUndefined();
  });

  it("AC-2: translation errors reject before any upstream call", async () => {
    const http = fakeHttp(() => jsonResponse(200, {}));
    const provider = createAnthropicProvider(config, http.client);
    const error = await gatewayError(provider.chat({ ...request, n: 3 }, ctx()));
    expect(error.code).toBe("unsupported_parameter");
    expect(http.calls).toHaveLength(0);
  });

  it("AC-5: embeddings → 400 embeddings_not_supported without calling upstream", async () => {
    const http = fakeHttp(() => jsonResponse(200, {}));
    const provider = createAnthropicProvider(config, http.client);
    const error = await gatewayError(provider.embeddings({ model: "m", input: "x" }, ctx()));
    expect(error.status).toBe(400);
    expect(error.code).toBe("embeddings_not_supported");
    expect(error.message).toContain('"claude"');
    expect(http.calls).toHaveLength(0);
  });

  it("AC-13: maps upstream statuses and keeps retry-after", async () => {
    const http = fakeHttp(() => ({
      status: 429,
      text: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }),
      headers: { "retry-after": "9", "request-id": "req_up_429" },
    }));
    const provider = createAnthropicProvider(config, http.client);
    const error = await gatewayError(provider.chat(request, ctx()));
    expect(error).toMatchObject({ status: 429, code: "upstream_rate_limited", retryable: true });
    expect(error.headers).toEqual({ "retry-after": "9" });
  });

  it.each([
    [new UpstreamTimeoutError("t"), 504, "upstream_timeout"],
    [new UpstreamNetworkError("n"), 502, "upstream_error"],
  ])("transport failure %s → %i retryable", async (failure, status, code) => {
    const http = fakeHttp(() => {
      throw failure;
    });
    const provider = createAnthropicProvider(config, http.client);
    const error = await gatewayError(provider.chat(request, ctx()));
    expect(error).toMatchObject({ status, code, retryable: true });
  });

  it("an unparseable 200 body → 502", async () => {
    const http = fakeHttp(() => ({ status: 200, text: "not json" }));
    const provider = createAnthropicProvider(config, http.client);
    expect((await gatewayError(provider.chat(request, ctx()))).code).toBe("upstream_error");
    const odd = fakeHttp(() => jsonResponse(200, { hello: "world" }));
    const other = createAnthropicProvider(config, odd.client);
    expect((await gatewayError(other.chat(request, ctx()))).code).toBe("upstream_error");
  });

  it("AC-10: streams translated chunks and asks for stream: true", async () => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => sseResponse(200, [fixtureText("stream-text.sse")]),
    );
    const provider = createAnthropicProvider(config, http.client);
    const { chunks, error } = await collect(await provider.chatStream(request, ctx()));
    expect(error).toBeUndefined();
    expect(http.calls[0]?.body).toMatchObject({ stream: true, max_tokens: 1024 });
    const text = chunks
      .map((c) => (c.choices as { delta?: { content?: string } }[])[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe("Hello!");
    expect(chunks.at(-1)).toMatchObject({ usage: { prompt_tokens: 35, completion_tokens: 15 } });
  });

  it("AC-12: a pre-stream error status rejects; an error event before content fails on first read", async () => {
    const failing = fakeHttp(
      () => jsonResponse(500, {}),
      () =>
        sseResponse(529, [
          JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "o" } }),
        ]),
    );
    const error = await gatewayError(
      createAnthropicProvider(config, failing.client).chatStream(request, ctx()),
    );
    expect(error).toMatchObject({ status: 503, code: "upstream_overloaded" });

    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => sseResponse(200, [fixtureText("stream-error-before-content.sse")]),
    );
    const stream = await createAnthropicProvider(config, http.client).chatStream(request, ctx());
    const { chunks, error: midError } = await collect(stream);
    expect(chunks).toEqual([]);
    expect(midError).toMatchObject({ code: "upstream_overloaded" });
  });

  it("a stream that ends without message_stop fails, as do malformed events", async () => {
    const truncated = fixtureText("stream-text.sse").split("event: message_delta")[0] ?? "";
    for (const body of [truncated, 'event: x\ndata: {"no_type":1}\n\n', "data: not-json\n\n"]) {
      const http = fakeHttp(
        () => jsonResponse(500, {}),
        () => sseResponse(200, [body]),
      );
      const stream = await createAnthropicProvider(config, http.client).chatStream(request, ctx());
      const { error } = await collect(stream);
      expect(error).toMatchObject({ code: "upstream_error" });
    }
  });

  it("maps transport failures during the stream", async () => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => sseResponse(200, [new UpstreamTimeoutError("idle")]),
    );
    const stream = await createAnthropicProvider(config, http.client).chatStream(request, ctx());
    expect((await collect(stream)).error).toMatchObject({ code: "upstream_timeout" });
  });
});

describe("anthropic provider span attributes (spec 014, AC-2/AC-13)", () => {
  let tracing: ReturnType<typeof installInMemoryTracing>;
  beforeAll(() => {
    tracing = installInMemoryTracing();
  });
  afterAll(async () => {
    await tracing.uninstall();
  });

  it("records dropped params and the upstream request id, never content", async () => {
    const http = fakeHttp(() => ({
      status: 200,
      text: JSON.stringify(fixtureJson("message-text.json")),
      headers: { "request-id": "req_up_1" },
    }));
    const provider = createAnthropicProvider(config, http.client);
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("upstream", async (span) => {
      await provider.chat({ ...request, seed: 1, presence_penalty: 0.5 }, ctx());
      span.end();
    });
    const span = tracing.exporter.getFinishedSpans().find((s) => s.name === "upstream");
    expect(span?.attributes["switchyard.dropped_params"]).toBe("seed,presence_penalty");
    expect(span?.attributes["switchyard.upstream.request_id"]).toBe("req_up_1");
    expect(JSON.stringify(span?.attributes)).not.toContain("hello");
  });
});
