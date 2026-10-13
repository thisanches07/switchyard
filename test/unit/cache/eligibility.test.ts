import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../../../src/core/chat.js";
import { GatewayError } from "../../../src/core/errors.js";
import {
  exactEligible,
  lastUserText,
  parseCacheHeader,
  semanticEligible,
} from "../../../src/modules/cache/eligibility.js";

const request = (fields: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "fast",
  messages: [{ role: "user", content: "hello" }],
  ...fields,
});

describe("parseCacheHeader (spec 009, AC-2)", () => {
  it.each([
    [undefined, "default"],
    ["force", "force"],
    ["bypass", "bypass"],
    [" Bypass ", "bypass"],
    ["FORCE", "force"],
  ] as const)("%j → %s", (value, mode) => {
    expect(parseCacheHeader(value)).toBe(mode);
  });

  it.each([["skip"], [""], ["force,bypass"], [["force", "bypass"]]])(
    "rejects %j with 400 invalid_cache_header",
    (value) => {
      let error: unknown;
      try {
        parseCacheHeader(value);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(GatewayError);
      expect(error).toMatchObject({ status: 400, code: "invalid_cache_header" });
    },
  );
});

describe("exactEligible (spec 009, AC-2)", () => {
  it("needs temperature 0, or force", () => {
    expect(exactEligible(request({ temperature: 0 }), "default")).toBe(true);
    expect(exactEligible(request(), "default")).toBe(false);
    expect(exactEligible(request({ temperature: 0.2 }), "default")).toBe(false);
    expect(exactEligible(request({ temperature: "0" }), "default")).toBe(false);
    expect(exactEligible(request(), "force")).toBe(true);
    expect(exactEligible(request({ temperature: 1.2 }), "force")).toBe(true);
  });

  it("needs at most one choice", () => {
    expect(exactEligible(request({ temperature: 0, n: 1 }), "default")).toBe(true);
    expect(exactEligible(request({ temperature: 0, n: null }), "default")).toBe(true);
    expect(exactEligible(request({ temperature: 0, n: 2 }), "default")).toBe(false);
    expect(exactEligible(request({ n: 2 }), "force")).toBe(false);
  });

  it("is never eligible with bypass", () => {
    expect(exactEligible(request({ temperature: 0 }), "bypass")).toBe(false);
  });
});

describe("semanticEligible (spec 009, AC-5)", () => {
  const MAX = 0.3;

  it("needs a temperature present and at most the cap; force does not relax it", () => {
    expect(semanticEligible(request({ temperature: 0 }), MAX, "default")).toBe(true);
    expect(semanticEligible(request({ temperature: 0.3 }), MAX, "default")).toBe(true);
    expect(semanticEligible(request({ temperature: 0.31 }), MAX, "default")).toBe(false);
    expect(semanticEligible(request(), MAX, "default")).toBe(false);
    expect(semanticEligible(request(), MAX, "force")).toBe(false);
    expect(semanticEligible(request({ temperature: 0.9 }), MAX, "force")).toBe(false);
    expect(semanticEligible(request({ temperature: 0 }), MAX, "bypass")).toBe(false);
  });

  it.each([
    ["tools", { tools: [{ type: "function", function: { name: "f" } }] }],
    ["functions", { functions: [{ name: "f" }] }],
    ["tool_choice", { tool_choice: "none" }],
    ["n > 1", { n: 2 }],
  ])("is not eligible with %s", (_name, fields) => {
    expect(semanticEligible(request({ temperature: 0, ...fields }), MAX, "default")).toBe(false);
  });

  it("ignores null or empty tool fields", () => {
    const fields = { temperature: 0, tools: [], functions: null, tool_choice: null };
    expect(semanticEligible(request(fields), MAX, "default")).toBe(true);
  });

  it("needs a final user message with text", () => {
    const assistantLast = request({
      temperature: 0,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(semanticEligible(assistantLast, MAX, "default")).toBe(false);
  });
});

describe("lastUserText", () => {
  it("reads a string or text parts of the final user message", () => {
    expect(lastUserText(request())).toBe("hello");
    expect(
      lastUserText(
        request({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          ],
        }),
      ),
    ).toBe("a\nb");
  });

  it.each([
    [
      "an image part",
      [
        { type: "text", text: "a" },
        { type: "image_url", image_url: { url: "x" } },
      ],
    ],
    ["empty text", ""],
    ["no parts", []],
    ["a number", 3],
  ])("is undefined with %s", (_name, content) => {
    expect(lastUserText(request({ messages: [{ role: "user", content }] }))).toBeUndefined();
  });

  it("is undefined when the final message is not from the user", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "tool", content: "42", tool_call_id: "c1" },
    ];
    expect(lastUserText(request({ messages }))).toBeUndefined();
  });
});
