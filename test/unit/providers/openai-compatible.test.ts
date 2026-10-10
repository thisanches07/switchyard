import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import { UpstreamNetworkError, UpstreamTimeoutError } from "../../../src/core/provider.js";
import { createOpenAiCompatibleProvider } from "../../../src/modules/providers/openai-compatible.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";

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
