import { describe, expect, it } from "vitest";
import {
  estimateChatTokens,
  estimateEmbeddingTokens,
} from "../../../src/modules/ratelimit/estimate.js";

const messages = [{ role: "user", content: "12345678" }]; // 8 chars → 2 tokens

describe("token estimates", () => {
  it("chat: input estimate plus max_completion_tokens first", () => {
    expect(
      estimateChatTokens({ model: "m", messages, max_completion_tokens: 100, max_tokens: 50 }, 512),
    ).toBe(102);
  });

  it("chat: falls back to max_tokens, then to the configured reserve", () => {
    expect(estimateChatTokens({ model: "m", messages, max_tokens: 50 }, 512)).toBe(52);
    expect(estimateChatTokens({ model: "m", messages }, 512)).toBe(514);
  });

  it("chat: ignores non-numeric or negative allowances", () => {
    expect(estimateChatTokens({ model: "m", messages, max_tokens: "big" }, 10)).toBe(12);
    expect(estimateChatTokens({ model: "m", messages, max_tokens: -5 }, 10)).toBe(12);
  });

  it.each([
    ["a string", "12345678", 2],
    ["an array of strings", ["1234", "12345"], 3],
    ["token ids", [1, 2, 3, 4, 5], 5],
    ["arrays of token ids", [[1, 2], [3]], 3],
    ["anything else", { weird: true }, 1],
  ])("embeddings: %s", (_label, input, expected) => {
    expect(estimateEmbeddingTokens(input)).toBe(expected);
  });
});
