import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk, ChatRequest } from "../../../src/core/chat.js";
import { upstreamError } from "../../../src/core/errors.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import type { UsageEvent } from "../../../src/core/usage.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { spyProvider } from "../../helpers/providers.js";

const CPF = "529.982.247-25";
const EMAIL = "ana.silva@example.com";

function lastUserText(request: ChatRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

/**
 * Streams what it received one character per chunk, as content and as tool-call arguments, so
 * every placeholder is split at every position. `fail` stops with an error right after `<CP`.
 */
const splitProvider: ChatProvider = {
  name: "mock",
  type: "mock",
  async chat() {
    throw new Error("not used");
  },
  async chatStream(request) {
    const text = lastUserText(request);
    const base = { id: "chatcmpl-split", object: "chat.completion.chunk", created: 1, model: "m" };
    const chunk = (delta: object, finish: string | null = null): ChatChunk => ({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const wantsUsage =
      (request.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
    return (async function* () {
      yield chunk({ role: "assistant", content: "" });
      if (request.model === "fail") {
        yield* [..."CPF <CP"].map((c) => chunk({ content: c }));
        throw upstreamError("mock");
      }
      for (const c of text) yield chunk({ content: c });
      yield chunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "save", arguments: "" } },
        ],
      });
      for (const c of JSON.stringify({ text })) {
        yield chunk({ tool_calls: [{ index: 0, function: { arguments: c } }] });
      }
      yield chunk({}, "stop");
      if (wantsUsage) {
        yield { ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } };
      }
    })();
  },
  async embeddings() {
    throw new Error("not used");
  },
};

type Event = Record<string, unknown> | "[DONE]";

function sse(body: string): Event[] {
  return body
    .split("\n\n")
    .filter((e) => e.startsWith("data: "))
    .map((e) => e.slice(6))
    .map((d) => (d === "[DONE]" ? "[DONE]" : (JSON.parse(d) as Record<string, unknown>)));
}

interface Delta {
  content?: string;
  tool_calls?: { index: number; function?: { arguments?: string } }[];
}
const deltaOf = (e: Event): Delta | undefined =>
  e === "[DONE]" ? undefined : (e.choices as { delta?: Delta }[] | undefined)?.[0]?.delta;

const contentOf = (events: Event[]) => events.map((e) => deltaOf(e)?.content ?? "").join("");
const argumentsOf = (events: Event[]) =>
  events
    .flatMap((e) => deltaOf(e)?.tool_calls ?? [])
    .map((c) => c.function?.arguments ?? "")
    .join("");

describe("PII restore in streamed chat answers (spec 015)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup() {
    const store = new MemoryKeyStore();
    const spy = spyProvider(splitProvider);
    const events: UsageEvent[] = [];
    // A long hold limit: these tests are about restoring, not about a slow machine's timing.
    const config = testConfig({ pii: { streamRestore: { maxHoldMs: 60_000 } } });
    const { app } = await testApp({
      store,
      config,
      providers: new Map([["mock", spy.provider]]),
      authenticated: false,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    const { key } = await store.issueKey({ piiMode: "mask" });
    const stream = (content: string, extra: object = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        payload: {
          model: "mock/split",
          messages: [{ role: "user", content }],
          stream: true,
          ...extra,
        },
      });
    return { spy, events, stream };
  }

  it("restores placeholders split one character per chunk, in content and arguments (AC-1, AC-2)", async () => {
    const { spy, stream } = await setup();
    const prompt = `CPF ${CPF}, mail ${EMAIL}`;
    const res = await stream(prompt);

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-pii"]).toBe("masked");
    expect(spy.requests[0]?.messages[0]?.content).toBe("CPF <CPF_1>, mail <EMAIL_1>");
    const events = sse(res.body);
    expect(contentOf(events)).toBe(prompt);
    expect(JSON.parse(argumentsOf(events))).toEqual({ text: prompt });
    // No event carries a placeholder or a piece of one.
    for (const e of events) expect(JSON.stringify(e)).not.toMatch(/<[A-Z]/);
  });

  it("ends with the finish chunk, then the usage chunk, then [DONE] (AC-6)", async () => {
    const { stream } = await setup();
    const res = await stream(`ends with ${CPF}`, { stream_options: { include_usage: true } });
    const events = sse(res.body);
    const tail = events.slice(-3);
    expect(tail[0]).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    expect(tail[1]).toMatchObject({ choices: [], usage: { prompt_tokens: 3 } });
    expect(tail[2]).toBe("[DONE]");
    expect(contentOf(events)).toBe(`ends with ${CPF}`);
  });

  it("estimates usage from the upstream text, not the restored one (AC-6)", async () => {
    const { stream, events } = await setup();
    const masked = "x <CPF_1>";
    await stream(`x ${CPF}`);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // The content the provider streamed is the masked text (9 chars → 3 tokens), not the CPF.
    expect(events[0]).toMatchObject({
      estimated: true,
      outputTokens: Math.ceil(masked.length / 4),
    });
  });

  it("releases held text before the error event of a mid-stream failure (AC-7)", async () => {
    const { spy, stream } = await setup();
    const res = await stream(`CPF ${CPF}`, { model: "mock/fail" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-ttfb-ms"]).toMatch(/^\d+$/);
    const events = sse(res.body);
    const last = events.at(-1) as Record<string, unknown>;
    expect(last).toMatchObject({ error: { code: "upstream_error" } });
    expect(events).not.toContain("[DONE]");
    // `<CP` was held; it reaches the client as-is, in the chunk just before the error event.
    expect(contentOf(events.slice(0, -1))).toBe("CPF <CP");
    expect(deltaOf(events.at(-2) as Event)?.content).toBe("<CP");
    // No retry or fallback after the first chunk (ADR-0008).
    expect(spy.requests).toHaveLength(1);
  });
});
