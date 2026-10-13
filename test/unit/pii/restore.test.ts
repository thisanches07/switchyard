import { describe, expect, it } from "vitest";
import { restoreChatResponse, restoreText } from "../../../src/modules/pii/restore.js";

const map = new Map([
  ["<CPF_1>", "529.982.247-25"],
  ["<EMAIL_1>", "ana@example.com"],
  ["<TERM_1>", 'say "hi" \\ now'],
]);

const completion = (choices: unknown[]) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "m",
  choices,
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
});

describe("restoreText (spec 010, AC-8)", () => {
  it("replaces every known placeholder", () => {
    expect(restoreText("CPF <CPF_1>, mail <EMAIL_1>, CPF again <CPF_1>.", map)).toBe(
      "CPF 529.982.247-25, mail ana@example.com, CPF again 529.982.247-25.",
    );
  });

  it("leaves unknown or altered placeholders untouched", () => {
    const text = "<CPF_9> <cpf_1> CPF_1 < CPF_1 > <CPF_1 <CPF-1> <CPF_01>";
    expect(restoreText(text, map)).toBe(text);
  });
});

describe("restoreChatResponse (spec 010, AC-8)", () => {
  it("restores content and tool-call arguments of every choice", () => {
    const body = completion([
      { index: 0, message: { role: "assistant", content: "Your CPF is <CPF_1>." } },
      {
        index: 1,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "send", arguments: '{"to":"<EMAIL_1>","text":"<TERM_1>"}' },
            },
          ],
        },
      },
    ]);
    const restored = restoreChatResponse(body, map) as ReturnType<typeof completion>;
    const [first, second] = restored.choices as {
      message: { content: string; tool_calls: { function: { arguments: string } }[] };
    }[];
    expect(first?.message.content).toBe("Your CPF is 529.982.247-25.");
    const args = second?.message.tool_calls[0]?.function.arguments ?? "";
    // Values are JSON-escaped inside arguments, so valid JSON stays valid.
    expect(JSON.parse(args)).toEqual({ to: "ana@example.com", text: 'say "hi" \\ now' });
    expect(restored.usage).toEqual(body.usage);
    expect(restored.id).toBe("chatcmpl-1");
  });

  it("restores text parts when content is an array", () => {
    const body = completion([
      { index: 0, message: { content: [{ type: "text", text: "<EMAIL_1>" }, { type: "x" }] } },
    ]);
    const restored = restoreChatResponse(body, map) as ReturnType<typeof completion>;
    expect((restored.choices[0] as { message: { content: unknown } }).message.content).toEqual([
      { type: "text", text: "ana@example.com" },
      { type: "x" },
    ]);
  });

  it("does not mutate the provider body", () => {
    const body = completion([{ index: 0, message: { content: "<CPF_1>" } }]);
    const before = structuredClone(body);
    restoreChatResponse(body, map);
    expect(body).toEqual(before);
  });

  it.each([
    ["null", null],
    ["a string", "<CPF_1>"],
    ["choices not an array", { choices: "<CPF_1>" }],
    ["odd choices", { choices: [null, 5, { message: 7 }, { message: { tool_calls: "x" } }] }],
    ["odd tool calls", { choices: [{ message: { tool_calls: [null, { function: 3 }] } }] }],
  ])("returns %s unchanged without throwing", (_label, body) => {
    expect(restoreChatResponse(body, map)).toEqual(body);
  });

  it("returns the same body when there is nothing to restore", () => {
    const body = completion([{ index: 0, message: { content: "<CPF_1>" } }]);
    expect(restoreChatResponse(body, new Map())).toBe(body);
  });
});
