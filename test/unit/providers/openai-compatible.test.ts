import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import { UpstreamNetworkError, UpstreamTimeoutError } from "../../../src/core/provider.js";
import { createOpenAiCompatibleProvider } from "../../../src/modules/providers/openai-compatible.js";
import { fakeHttp, jsonResponse, sse, streamResponse } from "../../helpers/http.js";

const completion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "llama3.2:latest",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
};

const request = {
  model: "llama3.2",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.2,
  seed: 7,
  response_format: { type: "json_object" },
};
const ctx = () => ({ signal: new AbortController().signal });

async function gatewayError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected GatewayError");
}

describe("openai-compatible provider", () => {
  it("posts to {baseUrl}/chat/completions and passes unknown fields through", async () => {
    const http = fakeHttp(() => jsonResponse(200, completion));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://ollama.test/v1/" },
      http.client,
    );
    const result = await provider.chat(request, ctx());

    expect(http.calls[0]?.url).toBe("http://ollama.test/v1/chat/completions");
    expect(http.calls[0]?.body).toEqual(request);
    expect(result.body).toEqual(completion);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.responseModel).toBe("llama3.2:latest");
  });

  it("sends a bearer key when configured", async () => {
    const http = fakeHttp(() => jsonResponse(200, completion));
    const provider = createOpenAiCompatibleProvider(
      { name: "groq", baseUrl: "http://groq.test/v1", apiKey: "gsk_test" },
      http.client,
    );
    await provider.chat(request, ctx());
    expect(http.calls[0]?.headers.authorization).toBe("Bearer gsk_test");
  });

  it("omits authorization without a key", async () => {
    const http = fakeHttp(() => jsonResponse(200, completion));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://ollama.test/v1" },
      http.client,
    );
    await provider.chat(request, ctx());
    expect(http.calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("reads provider-reported prompt-cache tokens (spec 006)", async () => {
    const cached = {
      ...completion,
      usage: { ...completion.usage, prompt_tokens_details: { cached_tokens: 10 } },
    };
    const http = fakeHttp(() => jsonResponse(200, cached));
    const provider = createOpenAiCompatibleProvider(
      { name: "openai", baseUrl: "http://o.test/v1" },
      http.client,
    );
    const result = await provider.chat(request, ctx());
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, cachedInputTokens: 10 });
  });

  it("tolerates responses without usage", async () => {
    const { usage: _usage, ...noUsage } = completion;
    const http = fakeHttp(() => jsonResponse(200, noUsage));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    const result = await provider.chat(request, ctx());
    expect(result.usage).toBeUndefined();
  });

  it("passes 4xx through with upstream error fields", async () => {
    const http = fakeHttp(() =>
      jsonResponse(400, {
        error: { message: "bad temperature", type: "invalid_request_error", code: "bad_param" },
      }),
    );
    const provider = createOpenAiCompatibleProvider(
      { name: "groq", baseUrl: "http://g.test/v1" },
      http.client,
    );
    const error = await gatewayError(provider.chat(request, ctx()));
    expect(error.status).toBe(400);
    expect(error.toBody()).toEqual({
      error: { message: "bad temperature", type: "invalid_request_error", code: "bad_param" },
    });
  });

  it("passes 4xx through when the body is not OpenAI-shaped", async () => {
    const http = fakeHttp(() => ({ status: 404, text: "model not found" }));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    const error = await gatewayError(provider.chat(request, ctx()));
    expect(error.status).toBe(404);
    expect(error.code).toBe("upstream_404");
  });

  it("maps 5xx to 502 without leaking the upstream body", async () => {
    const http = fakeHttp(() => ({ status: 500, text: "stack trace at internal.py:42" }));
    const provider = createOpenAiCompatibleProvider(
      { name: "groq", baseUrl: "http://g.test/v1" },
      http.client,
    );
    const error = await gatewayError(provider.chat(request, ctx()));
    expect(error.status).toBe(502);
    expect(error.code).toBe("upstream_error");
    expect(error.message).not.toContain("internal.py");
  });

  it("keeps the upstream retry-after on 429 and 503 (spec 008, AC-4)", async () => {
    let status = 429;
    const http = fakeHttp(() => ({ status, text: "{}", headers: { "retry-after": "3" } }));
    const provider = createOpenAiCompatibleProvider(
      { name: "groq", baseUrl: "http://g.test/v1" },
      http.client,
    );
    const limited = await gatewayError(provider.chat(request, ctx()));
    expect(limited.status).toBe(429);
    expect(limited.headers).toEqual({ "retry-after": "3" });

    status = 503;
    const unavailable = await gatewayError(provider.chat(request, ctx()));
    expect(unavailable.code).toBe("upstream_error");
    expect(unavailable.headers).toEqual({ "retry-after": "3" });

    status = 500;
    expect((await gatewayError(provider.chat(request, ctx()))).headers).toEqual({});
    status = 400;
    expect((await gatewayError(provider.chat(request, ctx()))).headers).toEqual({});
  });

  it("keeps retry-after when a stream is refused before it opens", async () => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => ({
        ...streamResponse(429, []),
        headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    );
    const provider = createOpenAiCompatibleProvider(
      { name: "groq", baseUrl: "http://g.test/v1" },
      http.client,
    );
    const error = await gatewayError(provider.chatStream(request, ctx()));
    expect(error.headers["retry-after"]).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  it("maps network errors to 502", async () => {
    const http = fakeHttp(() => {
      throw new UpstreamNetworkError("ECONNREFUSED");
    });
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    expect((await gatewayError(provider.chat(request, ctx()))).status).toBe(502);
  });

  it("maps timeouts to 504", async () => {
    const http = fakeHttp(() => {
      throw new UpstreamTimeoutError("headers timeout");
    });
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    expect((await gatewayError(provider.chat(request, ctx()))).status).toBe(504);
  });

  it("maps a non-JSON 200 to 502", async () => {
    const http = fakeHttp(() => ({ status: 200, text: "<html>proxy error</html>" }));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    expect((await gatewayError(provider.chat(request, ctx()))).code).toBe("upstream_error");
  });
});

describe("openai-compatible streaming", () => {
  const chunk = (content: string) => ({
    object: "chat.completion.chunk",
    model: "llama3.2",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });

  async function drain(stream: AsyncIterable<Record<string, unknown>>) {
    const out: Record<string, unknown>[] = [];
    for await (const c of stream) out.push(c);
    return out;
  }

  it("requests a stream with usage and yields parsed chunks", async () => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => streamResponse(200, [sse([chunk("Hel"), chunk("lo")])]),
    );
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1", apiKey: "k" },
      http.client,
    );
    const chunks = await drain(
      await provider.chatStream(
        { ...request, stream: true, stream_options: { include_usage: false, extra: 1 } },
        ctx(),
      ),
    );

    expect(http.calls[0]?.url).toBe("http://o.test/v1/chat/completions");
    expect(http.calls[0]?.headers.authorization).toBe("Bearer k");
    expect(http.calls[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true, extra: 1 },
      temperature: 0.2,
    });
    expect(chunks).toEqual([chunk("Hel"), chunk("lo")]);
  });

  it("maps non-2xx before the stream opens like the non-streaming path", async () => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () =>
        streamResponse(429, [], {
          text: JSON.stringify({ error: { message: "slow", type: "rate_limit_error" } }),
        }),
    );
    const provider = createOpenAiCompatibleProvider(
      { name: "groq", baseUrl: "http://g.test/v1" },
      http.client,
    );
    const error = await gatewayError(provider.chatStream(request, ctx()));
    expect(error.status).toBe(429);
    expect(error.type).toBe("rate_limit_error");
  });

  it("maps 5xx and connection errors before the stream opens", async () => {
    const failing = createOpenAiCompatibleProvider(
      { name: "g", baseUrl: "http://g.test/v1" },
      fakeHttp(
        () => jsonResponse(500, {}),
        () => streamResponse(503, [], { text: "internal trace" }),
      ).client,
    );
    expect((await gatewayError(failing.chatStream(request, ctx()))).status).toBe(502);

    const refused = createOpenAiCompatibleProvider(
      { name: "g", baseUrl: "http://g.test/v1" },
      fakeHttp(
        () => jsonResponse(500, {}),
        () => {
          throw new UpstreamNetworkError("ECONNREFUSED");
        },
      ).client,
    );
    expect((await gatewayError(refused.chatStream(request, ctx()))).status).toBe(502);
  });

  it.each([
    [new UpstreamTimeoutError("UND_ERR_BODY_TIMEOUT"), "upstream_timeout"],
    [new UpstreamNetworkError("ECONNRESET"), "upstream_error"],
  ])("mid-stream %s → gateway error %s", async (failure, code) => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => streamResponse(200, [sse([chunk("a")], false), failure]),
    );
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    const stream = await provider.chatStream(request, ctx());
    const received: unknown[] = [];
    const error = await (async () => {
      try {
        for await (const c of stream) received.push(c);
      } catch (e) {
        return e;
      }
    })();
    expect(received).toHaveLength(1);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe(code);
  });

  it("an invalid JSON chunk fails the stream with upstream_error", async () => {
    const http = fakeHttp(
      () => jsonResponse(500, {}),
      () => streamResponse(200, ["data: {not json\n\n"]),
    );
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    await expect(drain(await provider.chatStream(request, ctx()))).rejects.toMatchObject({
      code: "upstream_error",
    });
  });
});

describe("openai-compatible embeddings", () => {
  const body = {
    object: "list",
    data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
    model: "nomic-embed-text",
    usage: { prompt_tokens: 3, total_tokens: 3 },
  };

  it("posts to {baseUrl}/embeddings and returns the body with usage", async () => {
    const http = fakeHttp(() => jsonResponse(200, body));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    const embeddingsRequest = {
      model: "nomic-embed-text",
      input: ["a"],
      encoding_format: "base64",
    };
    const result = await provider.embeddings(embeddingsRequest, ctx());
    expect(http.calls[0]?.url).toBe("http://o.test/v1/embeddings");
    expect(http.calls[0]?.body).toEqual(embeddingsRequest);
    expect(result).toEqual({
      body,
      usage: { inputTokens: 3 },
      responseModel: "nomic-embed-text",
    });
  });

  it("maps embeddings errors like chat", async () => {
    const http = fakeHttp(() => ({ status: 500, text: "oops" }));
    const provider = createOpenAiCompatibleProvider(
      { name: "ollama", baseUrl: "http://o.test/v1" },
      http.client,
    );
    expect(
      (await gatewayError(provider.embeddings({ model: "m", input: "x" }, ctx()))).status,
    ).toBe(502);
  });
});
