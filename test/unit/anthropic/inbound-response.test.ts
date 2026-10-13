import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import {
  mapFinishReason,
  toAnthropicMessage,
  withRequestedModel,
} from "../../../src/modules/anthropic/inbound-response.js";

const completion = (message: Record<string, unknown>, finish = "stop", extra = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "llama3.2",
  choices: [
    { index: 0, message: { role: "assistant", ...message }, finish_reason: finish, ...extra },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});
const opts = { model: "fast", provider: "ollama" };

describe("toAnthropicMessage (spec 014, AC-8)", () => {
  it("text completion → Anthropic message with msg_ id and the requested model", () => {
    const message = toAnthropicMessage(completion({ content: "Hello" }), opts);
    expect(message).toEqual({
      id: expect.stringMatching(/^msg_[0-9a-f]{24}$/),
      type: "message",
      role: "assistant",
      model: "fast",
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  it("tool calls → tool_use blocks after the text, with parsed input", () => {
    const message = toAnthropicMessage(
      completion(
        {
          content: "Checking.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            { id: "call_2", type: "function", function: { name: "noop", arguments: "" } },
          ],
        },
        "tool_calls",
      ),
      opts,
    );
    expect(message.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_use", id: "call_2", name: "noop", input: {} },
    ]);
    expect(message.stop_reason).toBe("tool_use");
  });

  it("joins text parts and omits empty text", () => {
    expect(
      toAnthropicMessage(
        completion({
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        }),
        opts,
      ).content,
    ).toEqual([{ type: "text", text: "ab" }]);
    expect(toAnthropicMessage(completion({ content: "" }), opts).content).toEqual([]);
    expect(toAnthropicMessage(completion({ content: null }), opts).content).toEqual([]);
  });

  it("invalid tool-call JSON from the provider → 502 upstream_error", () => {
    let error: unknown;
    try {
      toAnthropicMessage(
        completion(
          { content: null, tool_calls: [{ id: "c", function: { name: "f", arguments: "{x" } }] },
          "tool_calls",
        ),
        opts,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(502);
  });

  it("a body that is not a chat completion → 502", () => {
    expect(() => toAnthropicMessage({ nope: true }, opts)).toThrow(GatewayError);
  });

  it("missing usage reports zeros", () => {
    const { usage: _usage, ...noUsage } = completion({ content: "x" });
    expect(toAnthropicMessage(noUsage, opts).usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});

describe("mapFinishReason (AC-8)", () => {
  it.each([
    ["stop", undefined, [], { stop_reason: "end_turn", stop_sequence: null }],
    ["length", undefined, [], { stop_reason: "max_tokens", stop_sequence: null }],
    ["tool_calls", undefined, [], { stop_reason: "tool_use", stop_sequence: null }],
    ["function_call", undefined, [], { stop_reason: "tool_use", stop_sequence: null }],
    ["content_filter", undefined, [], { stop_reason: "refusal", stop_sequence: null }],
    [null, undefined, [], { stop_reason: "end_turn", stop_sequence: null }],
    ["stop", "END", ["END"], { stop_reason: "stop_sequence", stop_sequence: "END" }],
    ["stop", "OTHER", ["END"], { stop_reason: "end_turn", stop_sequence: null }],
  ])("%s (matched %s of %j) → %j", (finish, matched, stops, expected) => {
    expect(mapFinishReason(finish, matched, stops)).toEqual(expected);
  });
});

describe("withRequestedModel (AC-7)", () => {
  it("keeps the upstream message and replaces only model", () => {
    const upstream = { id: "msg_up", type: "message", model: "claude-sonnet-5-5", content: [] };
    expect(withRequestedModel(upstream, "smart")).toEqual({ ...upstream, model: "smart" });
    expect(upstream.model).toBe("claude-sonnet-5-5");
  });
});
