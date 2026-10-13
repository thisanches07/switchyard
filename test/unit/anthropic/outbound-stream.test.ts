import { describe, expect, it } from "vitest";
import type { ChatChunk } from "../../../src/core/chat.js";
import { GatewayError } from "../../../src/core/errors.js";
import { createStreamTranslator } from "../../../src/modules/anthropic/outbound-stream.js";
import { fixtureEvents } from "../../helpers/anthropic-fixtures.js";

const created = 1_760_000_000;

/** Feeds events and returns, per event, the chunks produced (an error ends the run). */
function run(events: Record<string, unknown>[]) {
  const translator = createStreamTranslator("claude", created);
  const perEvent: ChatChunk[][] = [];
  let error: unknown;
  for (const event of events) {
    try {
      perEvent.push(translator.next(event));
    } catch (e) {
      error = e;
      break;
    }
  }
  return { translator, perEvent, chunks: perEvent.flat(), error };
}

const deltas = (chunks: ChatChunk[]) =>
  chunks.flatMap((c) => (c.choices as { delta?: Record<string, unknown> }[]).map((x) => x.delta));
const content = (chunks: ChatChunk[]) =>
  deltas(chunks)
    .map((d) => (typeof d?.content === "string" ? d.content : ""))
    .join("");

describe("Anthropic SSE → chat.completion.chunk (spec 014, AC-10)", () => {
  it("text stream: role chunk, content deltas, finish chunk, usage chunk", () => {
    const { chunks, translator } = run(fixtureEvents("stream-text.sse"));
    expect(chunks[0]).toEqual({
      id: "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY",
      object: "chat.completion.chunk",
      created,
      model: "claude-sonnet-5-5",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    expect(content(chunks)).toBe("Hello!");
    const finish = chunks.at(-2);
    expect(finish?.choices).toEqual([{ index: 0, delta: {}, finish_reason: "stop" }]);
    // Usage: input from message_start (25 + cache 10), output from the last message_delta.
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: {
        prompt_tokens: 35,
        completion_tokens: 15,
        total_tokens: 50,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    });
    expect(translator.done).toBe(true);
    expect(translator.usage()).toEqual({
      inputTokens: 35,
      outputTokens: 15,
      cachedInputTokens: 10,
    });
  });

  it("tool use stream: tool_calls with index, id, name, then argument fragments", () => {
    const { chunks } = run(fixtureEvents("stream-tool-use.sse"));
    const toolDeltas = deltas(chunks)
      .filter((d) => d?.tool_calls)
      .map((d) => d?.tool_calls);
    expect(toolDeltas).toEqual([
      [
        {
          index: 0,
          id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        },
      ],
      [{ index: 0, function: { arguments: '{"location":' } }],
      [{ index: 0, function: { arguments: ' "San Francisco, CA"}' } }],
      [
        {
          index: 1,
          id: "toolu_02",
          type: "function",
          function: { name: "get_time", arguments: "" },
        },
      ],
      [{ index: 1, function: { arguments: "{}" } }],
    ]);
    expect(content(chunks)).toBe("Okay, checking.");
    expect(chunks.at(-2)?.choices).toEqual([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
  });

  it("thinking produces nothing; the role chunk waits for the first visible output (AC-12)", () => {
    const { perEvent, chunks } = run(fixtureEvents("stream-thinking.sse"));
    // message_start + the whole thinking block (5 events) emit no chunk at all.
    expect(perEvent.slice(0, 6).flat()).toEqual([]);
    expect(deltas(chunks)[0]).toEqual({ role: "assistant", content: "" });
    expect(content(chunks)).toBe("The greatest common divisor of 1071 and 462 is **21**.");
    expect(JSON.stringify(chunks)).not.toContain("Euclidean");
    // No usage reported anywhere: no usage chunk.
    expect(chunks.some((c) => "usage" in c)).toBe(false);
  });

  it("an error event before any visible output throws before the first chunk", () => {
    const { chunks, error } = run(fixtureEvents("stream-error-before-content.sse"));
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("upstream_overloaded");
  });

  it("an error event after content throws after the content chunks", () => {
    const { chunks, error } = run(fixtureEvents("stream-error-after-content.sse"));
    expect(content(chunks)).toBe("Partial");
    expect((error as GatewayError).code).toBe("upstream_error");
  });

  it("ignores ping, signature and unknown events", () => {
    const translator = createStreamTranslator("claude", created);
    expect(translator.next({ type: "ping" })).toEqual([]);
    expect(translator.next({ type: "brand_new_event", foo: 1 })).toEqual([]);
    expect(
      translator.next({
        type: "content_block_delta",
        index: 9,
        delta: { type: "citations_delta" },
      }),
    ).toEqual([]);
  });

  it("an empty message still emits the role chunk with the finish", () => {
    const { chunks } = run([
      { type: "message_start", message: { id: "m", model: "x", usage: { input_tokens: 1 } } },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
    expect(deltas(chunks)[0]).toEqual({ role: "assistant", content: "" });
    expect(chunks.find((c) => (c.choices as unknown[]).length > 0 && c !== chunks[0])).toEqual(
      expect.objectContaining({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
    );
  });

  it.each([
    ["refusal", "content_filter"],
    ["pause_turn", "stop"],
    ["stop_sequence", "stop"],
    ["model_context_window_exceeded", "length"],
  ])("stop_reason %s → finish_reason %s", (reason, finish) => {
    const { chunks } = run([
      { type: "message_start", message: { id: "m", model: "x" } },
      { type: "message_delta", delta: { stop_reason: reason } },
    ]);
    expect(chunks.at(-1)?.choices).toEqual([{ index: 0, delta: {}, finish_reason: finish }]);
  });

  it("uses cumulative usage from the last message_delta, including late input counts", () => {
    const translator = createStreamTranslator("claude", created);
    translator.next({ type: "message_start", message: { id: "m", model: "x", usage: {} } });
    translator.next({ type: "message_delta", delta: {}, usage: { output_tokens: 3 } });
    translator.next({
      type: "message_delta",
      delta: {},
      usage: { output_tokens: 9, input_tokens: 4, cache_read_input_tokens: 2 },
    });
    expect(translator.usage()).toEqual({ inputTokens: 6, outputTokens: 9, cachedInputTokens: 2 });
  });
});
