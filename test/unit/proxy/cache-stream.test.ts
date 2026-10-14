import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatChunk } from "../../../src/core/chat.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import type { UsageEvent } from "../../../src/core/usage.js";
import { assembleCompletion } from "../../../src/modules/cache/chunks.js";
import { cacheApp, sseData } from "../../helpers/cache.js";

const messages = [{ role: "user", content: "12345678" }];
const ask = (extra: Record<string, unknown> = {}) => ({
  model: "fast",
  messages,
  temperature: 0,
  ...extra,
});

describe("cache and streaming (spec 009, AC-4, AC-7)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) {
      app.server.closeAllConnections();
      await app.close();
    }
  });

  async function setup(options: Parameters<typeof cacheApp>[0] = {}) {
    const setup = await cacheApp(options);
    apps.push(setup.app);
    return setup;
  }

  it("stores a streamed miss and serves it to a non-streaming client (AC-4)", async () => {
    const { chat, spies, events } = await setup();
    const streamed = await chat(ask({ stream: true, stream_options: { include_usage: true } }));
    expect(streamed.headers["x-switchyard-cache"]).toBe("miss");
    const assembled = assembleCompletion(sseData(streamed.body) as ChatChunk[]);

    const hit = await chat(ask());
    expect(hit.headers["x-switchyard-cache"]).toBe("hit");
    expect(spies.mock?.requests).toHaveLength(1);
    expect(hit.json().choices).toEqual(assembled?.choices);
    expect(hit.json().usage).toEqual(assembled?.usage);
    expect(events[1]).toMatchObject({ cacheStatus: "hit", stream: false, attempts: 0 });
  });

  it("re-chunks a stored response for a streaming client, ending in [DONE] (AC-7)", async () => {
    const { chat, spies, events } = await setup();
    const json = (await chat(ask())).json();
    const res = await chat(ask({ stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.headers).toMatchObject({
      "x-switchyard-cache": "hit",
      "x-switchyard-attempts": "0",
      "x-switchyard-provider": "mock",
    });
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const chunks = sseData(res.body);
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    // No usage chunk unless the client asked for it.
    expect(chunks.some((c) => "usage" in c)).toBe(false);
    const assembled = assembleCompletion(chunks as ChatChunk[]);
    expect(assembled?.choices).toEqual(
      (json.choices as object[]).map((c) => ({ logprobs: null, ...c })),
    );
    expect(spies.mock?.requests).toHaveLength(1);
    expect(events[1]).toMatchObject({
      cacheStatus: "hit",
      stream: true,
      inputTokens: 2,
      outputTokens: 6,
      outcome: "success",
    });
  });

  it("adds a final usage chunk when stream_options.include_usage is true (AC-7)", async () => {
    const { chat } = await setup();
    await chat(ask());
    const res = await chat(ask({ stream: true, stream_options: { include_usage: true } }));
    const chunks = sseData(res.body);
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 },
    });
    expect(chunks.slice(0, -1).some((c) => "usage" in c)).toBe(false);
  });

  it("stores nothing after a mid-stream failure (AC-4, ADR-0008)", async () => {
    const { chat, spies, exact } = await setup();
    const broken = ask({ model: "mock/error-midstream", stream: true });
    await chat(broken);
    const again = await chat(broken);
    expect(again.headers["x-switchyard-cache"]).toBe("miss");
    expect(spies.mock?.requests).toHaveLength(2);
    expect(exact.size).toBe(0);
  });

  it("stores nothing when the client leaves mid-stream (AC-4)", async () => {
    // A stream that sends one chunk, then waits until the request is aborted: no timers involved.
    const provider: ChatProvider = {
      name: "mock",
      type: "mock",
      chat: async () => {
        throw new Error("not used");
      },
      embeddings: async () => {
        throw new Error("not used");
      },
      async chatStream(_request, ctx) {
        return (async function* () {
          yield {
            id: "chatcmpl-held",
            object: "chat.completion.chunk",
            created: 1,
            model: "held",
            choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }],
          };
          await new Promise((_, reject) => {
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
          });
        })();
      },
    };
    let recorded!: (event: UsageEvent) => void;
    const event = new Promise<UsageEvent>((resolve) => {
      recorded = resolve;
    });
    const { app, registry, exact, key } = await setup({
      usageRecorder: { record: (e) => recorded(e) },
    });
    registry.set("mock", provider);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(ask({ model: "mock/held", stream: true })),
    });
    await res.body?.getReader().read();
    controller.abort();
    // The outcome is recorded exactly when the gateway sees the disconnect; nothing was stored.
    expect(await event).toMatchObject({ outcome: "client_closed", cacheStatus: "miss" });
    expect(exact.size).toBe(0);
  });
});
