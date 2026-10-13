import { describe, expect, it } from "vitest";
import {
  deltaText,
  estimateTokens,
  forwardChunk,
  messageChars,
  usageFromChunk,
} from "../../../src/modules/proxy/usage.js";

const contentChunk = {
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
};
const usageOnly = {
  object: "chat.completion.chunk",
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};
const contentWithUsage = { ...contentChunk, usage: usageOnly.usage };

describe("usage helpers", () => {
  it("extracts usage from a chunk", () => {
    expect(usageFromChunk(usageOnly)).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(usageFromChunk(contentChunk)).toBeUndefined();
    expect(usageFromChunk({ usage: null })).toBeUndefined();
  });

  it("forwards chunks unchanged when the client asked for usage", () => {
    expect(forwardChunk(usageOnly, true)).toBe(usageOnly);
    expect(forwardChunk(contentWithUsage, true)).toBe(contentWithUsage);
  });

  it("drops usage-only chunks when the client did not ask for usage", () => {
    expect(forwardChunk(usageOnly, false)).toBeUndefined();
  });

  it("strips usage from content chunks when the client did not ask for usage", () => {
    const forwarded = forwardChunk(contentWithUsage, false);
    expect(forwarded).toEqual(contentChunk);
    expect(contentWithUsage).toHaveProperty("usage");
  });

  it("forwards plain chunks untouched", () => {
    expect(forwardChunk(contentChunk, false)).toBe(contentChunk);
  });

  it("reads delta text across choices", () => {
    expect(
      deltaText({
        choices: [{ delta: { content: "ab" } }, { delta: { content: "c" } }, { delta: {} }],
      }),
    ).toBe("abc");
    expect(deltaText({ choices: "nope" })).toBe("");
  });

  it("counts characters of string message contents", () => {
    expect(
      messageChars({
        model: "m",
        messages: [
          { role: "user", content: "1234" },
          { role: "user", content: [{ type: "text", text: "ignored" }] },
        ],
      }),
    ).toBe(4);
  });

  it("estimates about four characters per token, rounding up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(8)).toBe(2);
    expect(estimateTokens(9)).toBe(3);
  });
});
