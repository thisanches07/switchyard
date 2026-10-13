import { describe, expect, it } from "vitest";
import {
  mapStopReason,
  toChatCompletion,
  usageFromAnthropic,
} from "../../../src/modules/anthropic/outbound-response.js";
import { fixtureJson } from "../../helpers/anthropic-fixtures.js";

const created = 1_760_000_000;

describe("toChatCompletion (spec 014, AC-3/AC-4)", () => {
  it("text message → chat.completion with cache-aware usage", () => {
    const result = toChatCompletion(fixtureJson("message-text.json"), created);
    expect(result.body).toEqual({
      id: "msg_013Zva2CMHLNnXjNJJKqJ2EF",
      object: "chat.completion",
      created,
      model: "claude-sonnet-5-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi! My name is Claude." },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 3995,
        completion_tokens: 503,
        total_tokens: 4498,
        prompt_tokens_details: { cached_tokens: 1800 },
      },
    });
    expect(result.usage).toEqual({ inputTokens: 3995, outputTokens: 503, cachedInputTokens: 1800 });
    expect(result.responseModel).toBe("claude-sonnet-5-5");
  });

  it("tool_use only → tool_calls with JSON-string arguments and null content", () => {
    const { body } = toChatCompletion(fixtureJson("message-tool-use.json"), created);
    expect(body.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_01A09q90qw90lq917835lq9",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"San Francisco, CA","unit":"celsius"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    });
  });

  it("mixed text + tool_use keeps both", () => {
    const { body } = toChatCompletion(fixtureJson("message-mixed.json"), created);
    expect(body.choices[0]?.message.content).toBe(
      "Okay, let's check the weather for San Francisco, CA:",
    );
    expect(body.choices[0]?.message.tool_calls).toHaveLength(1);
  });

  it("thinking and redacted_thinking blocks never reach the OpenAI response", () => {
    const { body } = toChatCompletion(fixtureJson("message-thinking.json"), created);
    expect(body.choices[0]?.message).toEqual({
      role: "assistant",
      content: "The greatest common divisor of 1071 and 462 is **21**.",
    });
    expect(JSON.stringify(body)).not.toContain("Euclidean");
  });

  it("concatenates several text blocks", () => {
    const { body } = toChatCompletion(
      {
        ...fixtureJson<Record<string, unknown>>("message-text.json"),
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      created,
    );
    expect(body.choices[0]?.message.content).toBe("ab");
  });

  it("rejects bodies that are not Anthropic messages", () => {
    expect(() => toChatCompletion({ hello: "world" }, created)).toThrow();
  });
});

describe("mapStopReason (AC-4)", () => {
  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
    ["something_new", "stop"],
    [null, "stop"],
  ])("%s → %s", (reason, expected) => {
    expect(mapStopReason(reason)).toBe(expected);
  });
});

describe("usageFromAnthropic (AC-4)", () => {
  it("folds cache reads and writes into input and reports reads as cached", () => {
    expect(
      usageFromAnthropic({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 7,
      }),
    ).toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 7 });
  });

  it("treats missing cache fields as zero and missing usage as unknown", () => {
    expect(usageFromAnthropic({ input_tokens: 1, output_tokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
    });
    expect(usageFromAnthropic(undefined)).toBeUndefined();
    expect(usageFromAnthropic({ output_tokens: "x" })).toBeUndefined();
  });
});
