import { describe, expect, it } from "vitest";
import { anthropicExtensionOf } from "../../../src/core/anthropic.js";
import { GatewayError } from "../../../src/core/errors.js";
import { fromAnthropicRequest } from "../../../src/modules/anthropic/inbound-request.js";
import {
  type MessagesRequest,
  parseMessagesRequest,
} from "../../../src/modules/anthropic/schema.js";

const base = (extra: Record<string, unknown> = {}): MessagesRequest =>
  ({
    model: "fast",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  }) as MessagesRequest;

const canonical = (body: MessagesRequest) => {
  const { request } = fromAnthropicRequest(body);
  return JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
};

describe("parseMessagesRequest (spec 014, AC-6)", () => {
  it.each([
    [{ messages: [{ role: "user", content: "x" }], max_tokens: 1 }, "model"],
    [{ model: "m", messages: [{ role: "user", content: "x" }] }, "max_tokens"],
    [{ model: "m", max_tokens: 0, messages: [{ role: "user", content: "x" }] }, "max_tokens"],
    [{ model: "m", max_tokens: 1, messages: [] }, "messages"],
    [
      { model: "m", max_tokens: 1, messages: [{ role: "system", content: "x" }] },
      "messages[0].role",
    ],
    [
      { model: "m", max_tokens: 1, messages: [{ role: "user", content: 1 }] },
      "messages[0].content",
    ],
    [{ ...base(), system: [{ type: "image" }] }, "system"],
    [{ ...base(), top_k: -1 }, "top_k"],
  ])("rejects %j naming %s", (body, field) => {
    let error: unknown;
    try {
      parseMessagesRequest(body);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(400);
    expect((error as GatewayError).message).toContain(field);
  });

  it("returns the body as received (key order and unknown fields kept)", () => {
    const body = { zeta: 1, ...base(), alpha: { b: 1, a: 2 } };
    const parsed = parseMessagesRequest(body);
    expect(parsed).toBe(body);
    expect(Object.keys(parsed)).toEqual(["zeta", "model", "max_tokens", "messages", "alpha"]);
  });
});

describe("fromAnthropicRequest (spec 014, AC-8)", () => {
  it("translates a minimal request", () => {
    expect(canonical(base())).toEqual({
      model: "fast",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
    });
  });

  it("system string and system blocks become system messages", () => {
    expect(canonical(base({ system: "Be brief." })).messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
    ]);
    expect(
      canonical(
        base({
          system: [
            { type: "text", text: "A", cache_control: { type: "ephemeral" } },
            { type: "text", text: "B" },
          ],
        }),
      ).messages,
    ).toEqual([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
    ]);
  });

  it("translates parameters, tools and tool_choice", () => {
    const result = canonical(
      base({
        stop_sequences: ["END"],
        temperature: 0.3,
        top_p: 0.8,
        top_k: 40,
        metadata: { user_id: "u-1" },
        tools: [
          {
            name: "get_weather",
            description: "Weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
            cache_control: { type: "ephemeral" },
          },
          { type: "custom", name: "noop", input_schema: { type: "object" } },
        ],
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        stream: true,
      }),
    );
    expect(result).toEqual({
      model: "fast",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      stop: ["END"],
      temperature: 0.3,
      top_p: 0.8,
      top_k: 40,
      user: "u-1",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
        { type: "function", function: { name: "noop", parameters: { type: "object" } } },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it.each([
    [{ type: "auto" }, "auto"],
    [{ type: "none" }, "none"],
    [{ type: "any" }, "required"],
    [
      { type: "tool", name: "f" },
      { type: "function", function: { name: "f" } },
    ],
  ])("tool_choice %j → %j", (choice, expected) => {
    expect(canonical(base({ tool_choice: choice })).tool_choice).toEqual(expected);
  });

  it("tool_use ↔ tool_calls and tool_result → tool messages; thinking and cache_control dropped", () => {
    const result = canonical(
      base({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Weather?", cache_control: { type: "ephemeral" } }],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret plan", signature: "sig" },
              { type: "redacted_thinking", data: "abc" },
              { type: "text", text: "Checking." },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "18C" },
              {
                type: "tool_result",
                tool_use_id: "toolu_2",
                content: [{ type: "text", text: "21C" }],
                is_error: true,
              },
              { type: "text", text: "Thanks" },
            ],
          },
        ],
      }),
    );
    expect(result.messages).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "18C" },
      { role: "tool", tool_call_id: "toolu_2", content: [{ type: "text", text: "21C" }] },
      { role: "user", content: "Thanks" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret plan");
    expect(JSON.stringify(result)).not.toContain("cache_control");
  });

  it("assistant tool calls without text have null content; multi-text content stays an array", () => {
    const result = canonical(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
          { role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: {} }] },
          { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }] },
        ],
      }),
    );
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }],
      },
    ]);
  });

  it("images become image_url parts", () => {
    const result = canonical(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
              { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
              { type: "text", text: "What?" },
            ],
          },
        ],
      }),
    );
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          { type: "text", text: "What?" },
        ],
      },
    ]);
  });

  it("reports blockers for the cross-family path, without failing the translation", () => {
    const { blockers } = fromAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "text", media_type: "text/plain", data: "x" } },
              { type: "image", source: { type: "file", file_id: "file_1" } },
              {
                type: "tool_result",
                tool_use_id: "t",
                content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
              },
              { type: "text", text: "summarise" },
            ],
          },
        ],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    );
    expect(blockers).toEqual([
      'messages[0].content[0] ("document" blocks)',
      "messages[0].content[1].source (only base64 and url image sources)",
      "messages[0].content[2].content[0] (only text inside tool_result)",
      'tools[0] (server tool "web_search_20250305")',
    ]);
  });

  it("attaches the extension with the body as received, slots and the beta header", () => {
    const body = base({ system: "S", metadata: { user_id: "u" } });
    const { request } = fromAnthropicRequest(body, { beta: "prompt-caching-2024-07-31" });
    const extension = anthropicExtensionOf(request);
    expect(extension?.body).toBe(body);
    expect(extension?.beta).toBe("prompt-caching-2024-07-31");
    expect(extension?.slots).toEqual([
      { canonical: ["messages", 0, "content"], native: ["system"], kind: "text", original: "S" },
      {
        canonical: ["messages", 1, "content"],
        native: ["messages", 0, "content"],
        kind: "text",
        original: "hi",
      },
    ]);
  });
});
