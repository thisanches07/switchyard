import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../../../src/core/chat.js";
import { PII_TYPES } from "../../../src/core/pii.js";
import { maskChatRequest, maskEmbeddingsRequest } from "../../../src/modules/pii/mask.js";
import { createScanner } from "../../../src/modules/pii/scan.js";

const scan = createScanner({ types: [...PII_TYPES], denyList: ["Project Falcon"] });
const CPF_A = "529.982.247-25";
const CPF_B = "111.444.777-35";

const chat = (messages: ChatRequest["messages"], extra: Record<string, unknown> = {}) =>
  ({ model: "fast", messages, ...extra }) as ChatRequest;

describe("maskChatRequest (spec 010, AC-7)", () => {
  it("numbers placeholders per type in order of appearance, same string same placeholder", () => {
    const result = maskChatRequest(
      chat([
        { role: "system", content: `Customer CPF ${CPF_A}.` },
        { role: "user", content: `Mail ana@example.com; CPF ${CPF_A} and ${CPF_B}.` },
      ]),
      scan,
    );
    expect(result.request.messages).toEqual([
      { role: "system", content: "Customer CPF <CPF_1>." },
      { role: "user", content: "Mail <EMAIL_1>; CPF <CPF_1> and <CPF_2>." },
    ]);
    expect(result.detections).toEqual({ cpf: 3, email: 1 });
    expect([...result.restore]).toEqual([
      ["<CPF_1>", CPF_A],
      ["<EMAIL_1>", "ana@example.com"],
      ["<CPF_2>", CPF_B],
    ]);
  });

  it("treats differently formatted values as different strings", () => {
    const result = maskChatRequest(chat([{ role: "user", content: `${CPF_A} 52998224725` }]), scan);
    expect(result.request.messages[0]?.content).toBe("<CPF_1> <CPF_2>");
  });

  it.each(["system", "developer", "user", "assistant", "tool"])("masks %s messages", (role) => {
    const result = maskChatRequest(chat([{ role, content: `id ${CPF_A}` }]), scan);
    expect(result.request.messages[0]?.content).toBe("id <CPF_1>");
  });

  it("masks text parts only, never images, audio or files", () => {
    const parts = [
      { type: "text", text: `cpf ${CPF_A}` },
      { type: "image_url", image_url: { url: `https://x.test/${CPF_A}.png` } },
      { type: "input_audio", input_audio: { data: "52998224725", format: "wav" } },
      { type: "text", text: "nothing here" },
    ];
    const result = maskChatRequest(chat([{ role: "user", content: parts }]), scan);
    expect(result.request.messages[0]?.content).toEqual([
      { type: "text", text: "cpf <CPF_1>" },
      parts[1],
      parts[2],
      parts[3],
    ]);
  });

  it("masks tool-call arguments of earlier turns, keeping JSON valid", () => {
    const args = JSON.stringify({ cpf: CPF_A, note: "line\nana@example.com", n: 1 });
    const result = maskChatRequest(
      chat([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "lookup", arguments: args } },
            {
              id: "c2",
              type: "function",
              function: { name: "raw", arguments: `cpf=${CPF_A} {broken` },
            },
          ],
        },
      ]),
      scan,
    );
    const calls = result.request.messages[0]?.tool_calls as {
      function: { name: string; arguments: string };
    }[];
    expect(JSON.parse(calls[0]?.function.arguments ?? "")).toEqual({
      cpf: "<CPF_1>",
      note: "line\n<EMAIL_1>",
      n: 1,
    });
    expect(calls[1]?.function).toEqual({ name: "raw", arguments: "cpf=<CPF_1> {broken" });
  });

  it("leaves tool definitions, names and other parameters untouched", () => {
    const tools = [{ type: "function", function: { name: "f", description: `ask ${CPF_A}` } }];
    const result = maskChatRequest(
      chat([{ role: "user", name: "ana@example.com", content: "hi" }], {
        tools,
        user: "ana@example.com",
        temperature: 0.2,
      }),
      scan,
    );
    expect(result.request).toEqual(
      chat([{ role: "user", name: "ana@example.com", content: "hi" }], {
        tools,
        user: "ana@example.com",
        temperature: 0.2,
      }),
    );
    expect(result.detections).toEqual({});
  });

  it("skips placeholder numbers the client already used", () => {
    const result = maskChatRequest(
      chat([
        { role: "system", content: "Refer to values as <CPF_1> and <EMAIL_3>." },
        { role: "user", content: `Mine is ${CPF_A}, mail ana@example.com` },
      ]),
      scan,
    );
    expect(result.request.messages[1]?.content).toBe("Mine is <CPF_2>, mail <EMAIL_4>");
    expect([...result.restore.keys()]).toEqual(["<CPF_2>", "<EMAIL_4>"]);
  });

  it("masks deny-list terms as <TERM_n>", () => {
    const result = maskChatRequest(
      chat([{ role: "user", content: "About PROJECT FALCON." }]),
      scan,
    );
    expect(result.request.messages[0]?.content).toBe("About <TERM_1>.");
    expect(result.restore.get("<TERM_1>")).toBe("PROJECT FALCON");
  });

  it("never mutates the parsed request", () => {
    const request = chat([
      { role: "user", content: [{ type: "text", text: CPF_A }] },
      {
        role: "assistant",
        tool_calls: [{ function: { name: "f", arguments: JSON.stringify({ c: CPF_A }) } }],
      },
    ]);
    const before = structuredClone(request);
    maskChatRequest(request, scan);
    expect(request).toEqual(before);
  });

  it("reports nothing and keeps the content when there is no PII", () => {
    const request = chat([{ role: "user", content: "hello" }]);
    const result = maskChatRequest(request, scan);
    expect(result.request).toEqual(request);
    expect(result.detections).toEqual({});
    expect(result.restore.size).toBe(0);
  });
});

describe("maskEmbeddingsRequest (spec 010, AC-7)", () => {
  it("masks a string input", () => {
    const result = maskEmbeddingsRequest({ model: "e", input: `cpf ${CPF_A}` }, scan);
    expect(result.request.input).toBe("cpf <CPF_1>");
    expect(result.detections).toEqual({ cpf: 1 });
    expect(result.uninspected).toBe(false);
  });

  it("masks an array of strings with shared numbering", () => {
    const result = maskEmbeddingsRequest(
      { model: "e", input: [CPF_A, `again ${CPF_A}`, "ana@example.com"] },
      scan,
    );
    expect(result.request.input).toEqual(["<CPF_1>", "again <CPF_1>", "<EMAIL_1>"]);
  });

  it("passes token arrays through as uninspected", () => {
    const input = [
      [1, 2, 3],
      [4, 5],
    ];
    const result = maskEmbeddingsRequest({ model: "e", input }, scan);
    expect(result.request.input).toBe(input);
    expect(result.uninspected).toBe(true);
    expect(result.detections).toEqual({});
  });
});
