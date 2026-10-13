import { describe, expect, it } from "vitest";
import { withNativeEvent } from "../../../src/core/anthropic.js";
import type { ChatChunk } from "../../../src/core/chat.js";
import { upstreamError, upstreamOverloaded } from "../../../src/core/errors.js";
import { createAnthropicEncoder } from "../../../src/modules/anthropic/inbound-stream.js";
import { fixtureEvents, fixtureText } from "../../helpers/anthropic-fixtures.js";

const chunk = (delta: Record<string, unknown>, finish: string | null = null): ChatChunk => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** Parses encoder output back into `{event, data}` pairs. */
function parse(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return {
        event: eventLine?.replace("event: ", ""),
        data: JSON.parse(dataLine?.replace("data: ", "") ?? "null") as Record<string, unknown>,
      };
    });
}

function encode(chunks: ChatChunk[], usage = { inputTokens: 11, outputTokens: 7 }) {
  const encoder = createAnthropicEncoder({ model: "fast", stopSequences: ["END"], inputTokens: 3 });
  const text = chunks.flatMap((c) => encoder.chunk(c)).join("") + encoder.end(usage).join("");
  return parse(text);
}

describe("Anthropic SSE encoder, cross-family (spec 014, AC-11)", () => {
  it("synthesises the documented event order for a text answer", () => {
    const events = encode([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      { object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11 } },
    ]);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    for (const e of events) expect(e.data.type).toBe(e.event);
    expect(events[0]?.data.message).toMatchObject({
      id: expect.stringMatching(/^msg_/),
      type: "message",
      role: "assistant",
      model: "fast",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    });
    expect(events[1]?.data).toMatchObject({ index: 0, content_block: { type: "text", text: "" } });
    expect(events[2]?.data.delta).toEqual({ type: "text_delta", text: "Hel" });
    expect(events[5]?.data).toMatchObject({
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    expect(events.some((e) => JSON.stringify(e).includes("[DONE]"))).toBe(false);
  });

  it("tool calls become tool_use blocks with input_json_delta, after the text block", () => {
    const events = encode([
      chunk({ role: "assistant", content: "Checking." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      chunk({
        tool_calls: [{ index: 1, id: "call_2", function: { name: "noop", arguments: "{}" } }],
      }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.map((e) => [e.event, e.data.index])).toEqual([
      ["message_start", undefined],
      ["content_block_start", 0],
      ["content_block_delta", 0],
      ["content_block_stop", 0],
      ["content_block_start", 1],
      ["content_block_delta", 1],
      ["content_block_delta", 1],
      ["content_block_stop", 1],
      ["content_block_start", 2],
      ["content_block_delta", 2],
      ["content_block_stop", 2],
      ["message_delta", undefined],
      ["message_stop", undefined],
    ]);
    expect(events[4]?.data.content_block).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: {},
    });
    expect(events[6]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '"Paris"}' });
    expect(events.at(-2)?.data.delta).toMatchObject({ stop_reason: "tool_use" });
  });

  it("an empty stream still produces a complete message", () => {
    expect(encode([]).map((e) => e.event)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
  });

  it("maps length to max_tokens", () => {
    const events = encode([chunk({ content: "x" }, "length")]);
    expect(events.at(-2)?.data.delta).toMatchObject({ stop_reason: "max_tokens" });
  });

  it("mid-stream errors are one Anthropic error event", () => {
    const encoder = createAnthropicEncoder({ model: "fast" });
    expect(parse(encoder.error(upstreamOverloaded("claude")))).toEqual([
      {
        event: "error",
        data: {
          type: "error",
          error: { type: "overloaded_error", message: 'Provider "claude" is overloaded' },
        },
      },
    ]);
    expect(parse(encoder.error(upstreamError("x")))[0]?.data.error).toMatchObject({
      type: "api_error",
    });
  });
});

describe("Anthropic SSE encoder, same-family (spec 014, AC-7/AC-11)", () => {
  it("forwards upstream events unchanged except the model in message_start", () => {
    const raw = fixtureText("stream-tool-use.sse");
    const datas = raw
      .split("\n\n")
      .filter(Boolean)
      .map((block) => block.split("\n")[1]?.slice(6) ?? "");
    const encoder = createAnthropicEncoder({ model: "smart" });
    const out = fixtureEvents("stream-tool-use.sse").map((e, i) =>
      encoder.chunk(
        withNativeEvent({ choices: [] }, { type: String(e.type), data: datas[i] ?? "" }),
      ),
    );
    // Canonical companion chunks without a native event are skipped.
    expect(encoder.chunk(chunk({ content: "dup" }))).toEqual([]);
    expect(encoder.end({ inputTokens: 1, outputTokens: 1 })).toEqual([]);

    const text = out.flat().join("");
    const expected = raw.replace('"model":"claude-sonnet-5-5"', '"model":"smart"');
    expect(parse(text)).toEqual(parse(expected));
    // Every event except message_start is byte-identical.
    expect(text.slice(text.indexOf("event: content_block_start"))).toBe(
      raw.slice(raw.indexOf("event: content_block_start")),
    );
  });
});
