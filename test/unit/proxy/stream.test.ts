import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatChunk } from "../../../src/core/chat.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { createMockProvider } from "../../../src/modules/providers/mock.js";
import { testApp } from "../../helpers/app.js";
import { spiedRegistry } from "../../helpers/providers.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const messages = [{ role: "user", content: "12345678" }];

/** Parses an SSE body into data payloads (JSON objects or the literal "[DONE]"). */
function events(body: string): (Record<string, unknown> | "[DONE]")[] {
  return body
    .split("\n\n")
    .filter((e) => e.startsWith("data: "))
    .map((e) => e.slice(6))
    .map((d) => (d === "[DONE]" ? "[DONE]" : (JSON.parse(d) as Record<string, unknown>)));
}

const text = (evts: ReturnType<typeof events>) =>
  evts
    .filter((e): e is Record<string, unknown> => e !== "[DONE]")
    .map((e) => (e.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content)
    .join("");

describe("POST /v1/chat/completions with stream: true", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  let tracing: ReturnType<typeof installInMemoryTracing>;
  beforeAll(() => {
    tracing = installInMemoryTracing();
  });
  afterAll(async () => {
    await tracing.uninstall();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function post(payload: Record<string, unknown>, providers?: Map<string, ChatProvider>) {
    const registry = providers ?? spiedRegistry().registry;
    const { app } = await testApp({ providers: registry });
    apps.push(app);
    return app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages, stream: true, ...payload },
    });
  }

  it("streams SSE chunks and ends with [DONE]", async () => {
    const res = await post({ model: "fast" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    const evts = events(res.body);
    expect(evts.at(-1)).toBe("[DONE]");
    expect(text(evts)).toBe("This is a mock response.");
    expect(evts[0]).toMatchObject({ object: "chat.completion.chunk", model: "fast-model" });
  });

  it("sends Switchyard headers including TTFB", async () => {
    const res = await post({ model: "fast" });
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(res.headers["x-switchyard-model"]).toBe("fast-model");
    expect(res.headers["x-switchyard-ttfb-ms"]).toMatch(/^\d+$/);
    expect(res.headers["x-switchyard-request-id"]).toMatch(/^req_/);
  });

  it.each([
    ["gpt-9", 404, "model_not_found"],
    ["mock/error-500", 502, "upstream_error"],
    ["mock/error-429", 429, "rate_limit_exceeded"],
  ])("%s fails before the first byte with a JSON error (%i)", async (model, status, code) => {
    const res = await post({ model });
    expect(res.statusCode).toBe(status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json().error.code).toBe(code);
  });

  it("a mid-stream failure ends the stream with an error event and no [DONE]", async () => {
    const res = await post({ model: "mock/error-midstream" });
    expect(res.statusCode).toBe(200);
    const evts = events(res.body);
    expect(evts).not.toContain("[DONE]");
    expect(evts.at(-1)).toEqual({
      error: expect.objectContaining({ type: "server_error", code: "upstream_error" }),
    });
    expect(evts.length).toBeGreaterThan(1);
  });

  it("does not retry after the first byte (ADR-0008)", async () => {
    const { registry, spies } = spiedRegistry();
    await post({ model: "mock/error-midstream" }, registry);
    expect(spies.mock?.requests).toHaveLength(1);
  });

  it("forwards the usage chunk only when the client asked for it", async () => {
    const withUsage = events(
      (await post({ model: "fast", stream_options: { include_usage: true } })).body,
    );
    const usageEvent = withUsage.find((e) => e !== "[DONE]" && "usage" in e);
    expect(usageEvent).toMatchObject({ choices: [], usage: { completion_tokens: 6 } });

    const withoutUsage = events((await post({ model: "fast" })).body);
    expect(withoutUsage.some((e) => e !== "[DONE]" && "usage" in e)).toBe(false);
  });

  it("always asks the provider for usage", async () => {
    const { registry, spies } = spiedRegistry();
    await post({ model: "fast" }, registry);
    expect(spies.mock?.requests[0]?.stream).toBe(true);
  });

  it("estimates usage when the provider reports none", async () => {
    const noUsage: ChatProvider = {
      ...createMockProvider("mock", { latencyMs: 0, errorRate: 0 }),
      async chatStream() {
        return (async function* (): AsyncGenerator<ChatChunk> {
          yield {
            object: "chat.completion.chunk",
            model: "m",
            choices: [{ index: 0, delta: { content: "abcdefgh" } }],
          };
          yield {
            object: "chat.completion.chunk",
            model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
        })();
      },
    };
    const registry = spiedRegistry().registry;
    registry.set("mock", noUsage);
    tracing.exporter.reset();
    const res = await post({ model: "mock/m", stream_options: { include_usage: true } }, registry);
    expect(res.statusCode).toBe(200);
    const span = tracing.exporter.getFinishedSpans().find((s) => s.name === "switchyard.upstream");
    expect(span?.attributes).toMatchObject({
      "switchyard.usage.estimated": true,
      "gen_ai.usage.input_tokens": 2,
      "gen_ai.usage.output_tokens": 2,
      "switchyard.stream": true,
    });
  });
});
