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

  it("the echo model answers with the last user message, text parts included (spec 010)", async () => {
    const mock = createMockProvider("mock", { latencyMs: 0, errorRate: 0 });
    const { body } = await mock.chat(request("echo"), ctx());
    expect(body).toMatchObject({
      choices: [{ message: { role: "assistant", content: "Tell me a secret: hunter2" } }],
    });
    const parts = await mock.chat(
      {
        model: "echo",
        messages: [
          { role: "user", content: "first" },
          {
            role: "user",
            content: [
              { type: "text", text: "a " },
              { type: "image_url", image_url: { url: "x" } },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      ctx(),
    );
    expect(parts.body).toMatchObject({ choices: [{ message: { content: "a b" } }] });
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

async function drain(stream: AsyncIterable<Record<string, unknown>>) {
  const chunks: Record<string, unknown>[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const content = (chunks: Record<string, unknown>[]) =>
  chunks
    .map((c) => (c.choices as { delta?: { content?: string } }[])[0]?.delta?.content ?? "")
    .join("");

describe("mock provider streaming", () => {
  const config = { latencyMs: 0, errorRate: 0, chunkDelayMs: 0 };

  it("streams role, content pieces and a finish chunk", async () => {
    const mock = createMockProvider("mock", config);
    const chunks = await drain(await mock.chatStream(request("m"), ctx()));

    expect(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === "m")).toBe(true);
    expect(content(chunks)).toBe("This is a mock response.");
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    expect(chunks.some((c) => "usage" in c)).toBe(false);
  });

  it("the echo model streams the last user message in several pieces (spec 010)", async () => {
    const mock = createMockProvider("mock", config);
    const chunks = await drain(await mock.chatStream(request("echo"), ctx()));
    expect(content(chunks)).toBe("Tell me a secret: hunter2");
    expect(chunks.filter((c) => content([c]) !== "").length).toBeGreaterThan(1);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  });

  it("adds a usage chunk when the request asks for it", async () => {
    const mock = createMockProvider("mock", config);
    const chunks = await drain(
      await mock.chatStream({ ...request("m"), stream_options: { include_usage: true } }, ctx()),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      }),
    );
  });

  it("waits chunkDelayMs between chunks", async () => {
    const mock = createMockProvider("mock", { ...config, chunkDelayMs: 30 });
    const started = performance.now();
    const chunks = await drain(await mock.chatStream(request("m"), ctx()));
    expect(performance.now() - started).toBeGreaterThanOrEqual(30 * (chunks.length - 1) - 5);
  });

  it("error-midstream fails after sending at least one chunk", async () => {
    const mock = createMockProvider("mock", config);
    const stream = await mock.chatStream(request("error-midstream"), ctx());
    const received: unknown[] = [];
    const error = await (async () => {
      try {
        for await (const chunk of stream) received.push(chunk);
      } catch (e) {
        return e;
      }
    })();
    expect(received.length).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("upstream_error");
  });

  it("error-500 rejects before the stream opens", async () => {
    const mock = createMockProvider("mock", config);
    expect((await gatewayError(mock.chatStream(request("error-500"), ctx()))).status).toBe(502);
  });

  it("aborting during the stream stops it with a gateway error", async () => {
    const mock = createMockProvider("mock", { ...config, chunkDelayMs: 1_000 });
    const controller = new AbortController();
    const stream = await mock.chatStream(request("m"), { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("mock provider embeddings", () => {
  const mock = createMockProvider("mock", { latencyMs: 0, errorRate: 0, chunkDelayMs: 0 });
  type Body = {
    object: string;
    data: { object: string; index: number; embedding: number[] | string }[];
    usage: { prompt_tokens: number; total_tokens: number };
  };

  it("returns one normalised 768-dim vector per input with usage", async () => {
    const result = await mock.embeddings({ model: "embed", input: ["hello", "world!!!"] }, ctx());
    const body = result.body as Body;
    expect(body.object).toBe("list");
    expect(body.data.map((d) => d.index)).toEqual([0, 1]);
    for (const item of body.data) {
      const vector = item.embedding as number[];
      expect(vector).toHaveLength(768);
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
    expect(body.usage).toEqual({ prompt_tokens: 4, total_tokens: 4 });
    expect(result.usage).toEqual({ inputTokens: 4 });
  });

  it("is deterministic per text and accepts a single string", async () => {
    const a = (await mock.embeddings({ model: "e", input: "same" }, ctx())).body as Body;
    const b = (await mock.embeddings({ model: "e", input: ["same", "other"] }, ctx())).body as Body;
    expect(a.data[0]?.embedding).toEqual(b.data[0]?.embedding);
    expect(b.data[0]?.embedding).not.toEqual(b.data[1]?.embedding);
  });

  it("encodes base64 float32 when asked", async () => {
    const floats = (await mock.embeddings({ model: "e", input: "x" }, ctx())).body as Body;
    const b64 = (
      await mock.embeddings({ model: "e", input: "x", encoding_format: "base64" }, ctx())
    ).body as Body;
    const bytes = Buffer.from(b64.data[0]?.embedding as string, "base64");
    const decoded = Array.from(
      new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    );
    const vector = floats.data[0]?.embedding as number[];
    const expected = vector.map((v) => Math.fround(v));
    expect(decoded).toEqual(expected);
  });

  it("error-<status> models fail for embeddings too", async () => {
    expect(
      (await gatewayError(mock.embeddings({ model: "error-503", input: "x" }, ctx()))).status,
    ).toBe(502);
  });
});
