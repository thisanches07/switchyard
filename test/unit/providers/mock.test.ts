import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import { createMockProvider } from "../../../src/modules/providers/mock.js";

const request = (model: string) => ({
  model,
  messages: [
    { role: "system", content: "You are terse." },
    { role: "user", content: "Tell me a secret: hunter2" },
  ],
});
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

describe("mock provider", () => {
  it("returns a deterministic chat.completion with usage", async () => {
    const mock = createMockProvider("mock", { latencyMs: 0, errorRate: 0 });
    const first = await mock.chat(request("any"), ctx());
    const second = await mock.chat(request("any"), ctx());

    expect(first.body).toMatchObject({
      object: "chat.completion",
      model: "any",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "This is a mock response." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    });
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 6 });
    expect(first.responseModel).toBe("any");
    expect((second.body as { choices: unknown }).choices).toEqual(
      (first.body as { choices: unknown }).choices,
    );
  });

  it("never echoes message content", async () => {
    const mock = createMockProvider("mock", { latencyMs: 0, errorRate: 0 });
    const { body } = await mock.chat(request("any"), ctx());
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("honours latencyMs", async () => {
    const mock = createMockProvider("mock", { latencyMs: 60, errorRate: 0 });
    const started = performance.now();
    await mock.chat(request("any"), ctx());
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("aborts while waiting", async () => {
    const mock = createMockProvider("mock", { latencyMs: 5_000, errorRate: 0 });
    const controller = new AbortController();
    const pending = mock.chat(request("any"), { signal: controller.signal });
    controller.abort(new DOMException("timed out", "TimeoutError"));
    const error = await gatewayError(pending);
    expect(error.status).toBe(504);
  });

  it.each([
    ["error-500", 502, "upstream_error"],
    ["error-503", 502, "upstream_error"],
    ["error-429", 429, "rate_limit_exceeded"],
    ["error-400", 400, "upstream_400"],
  ])("model %s fails with gateway status %i (%s)", async (model, status, code) => {
    const mock = createMockProvider("mock", { latencyMs: 0, errorRate: 0 });
    const error = await gatewayError(mock.chat(request(model), ctx()));
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  it("fails according to errorRate", async () => {
    const values = [0.1, 0.9];
    const mock = createMockProvider(
      "mock",
      { latencyMs: 0, errorRate: 0.5 },
      { random: () => values.shift() ?? 1 },
    );
    expect((await gatewayError(mock.chat(request("any"), ctx()))).status).toBe(502);
    await expect(mock.chat(request("any"), ctx())).resolves.toBeDefined();
  });
});
