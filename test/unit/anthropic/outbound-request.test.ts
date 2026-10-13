import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../../../src/core/chat.js";
import { GatewayError } from "../../../src/core/errors.js";
import { toAnthropicRequest } from "../../../src/modules/anthropic/outbound-request.js";

const options = { defaultMaxTokens: 4096 };
const user = (content: unknown) => ({ role: "user", content });
const req = (extra: Partial<ChatRequest> & Record<string, unknown> = {}): ChatRequest => ({
  model: "claude-sonnet-5-5",
  messages: [user("hi")],
  ...extra,
});
const body = (request: ChatRequest) => toAnthropicRequest(request, options).body;

function rejection(request: ChatRequest): GatewayError {
  try {
    toAnthropicRequest(request, options);
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected a GatewayError");
}

describe("toAnthropicRequest (spec 014, AC-2)", () => {
  it("translates a minimal request", () => {
    expect(body(req())).toEqual({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    });
  });

  it("concatenates system and developer messages, in order, into the top-level system", () => {
    const result = body(
      req({
        messages: [
          { role: "system", content: "Be brief." },
          user("hi"),
          { role: "developer", content: [{ type: "text", text: "Answer in English." }] },
        ],
      }),
    );
    expect(result.system).toBe("Be brief.\n\nAnswer in English.");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("merges consecutive messages of the same role", () => {
    const result = body(
      req({
        messages: [
          user("one"),
          user([{ type: "text", text: "two" }]),
          { role: "assistant", content: "ok" },
          { role: "assistant", content: "more" },
        ],
      }),
    );
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "text", text: "more" },
        ],
      },
    ]);
  });

  it.each([
    [{ max_completion_tokens: 10, max_tokens: 20 }, 10],
    [{ max_tokens: 20 }, 20],
    [{}, 4096],
    [{ max_tokens: null }, 4096],
  ])("max tokens precedence %j → %i", (extra, expected) => {
    expect(body(req(extra)).max_tokens).toBe(expected);
  });

  it.each([
    ["END", ["END"]],
    [
      ["a", "b"],
      ["a", "b"],
    ],
  ])("stop %j → stop_sequences %j", (stop, expected) => {
    expect(body(req({ stop })).stop_sequences).toEqual(expected);
  });

  it("passes temperature and top_p through and maps user to metadata.user_id", () => {
    expect(body(req({ temperature: 0.2, top_p: 0.9, user: "u-1" }))).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      metadata: { user_id: "u-1" },
    });
  });

  it("translates image parts: data URIs to base64 sources, URLs to url sources", () => {
    const result = body(
      req({
        messages: [
          user([
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
            { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
          ]),
        ],
      }),
    );
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
          { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
        ],
      },
    ]);
  });

  it.each([
    [{ n: 2 }, "n"],
    [{ logprobs: true }, "logprobs"],
    [{ top_logprobs: 3 }, "top_logprobs"],
    [{ response_format: { type: "json_object" } }, "response_format"],
    [{ response_format: { type: "json_schema", json_schema: {} } }, "response_format"],
  ])("rejects %j with 400 unsupported_parameter naming %s", (extra, param) => {
    const error = rejection(req(extra));
    expect(error.status).toBe(400);
    expect(error.code).toBe("unsupported_parameter");
    expect(error.message).toContain(param);
  });

  it("accepts the harmless forms of rejected parameters", () => {
    expect(() =>
      body(req({ n: 1, logprobs: false, response_format: { type: "text" } })),
    ).not.toThrow();
  });

  it("drops penalties, seed, logit_bias and unknown fields, and lists them", () => {
    const { body: result, dropped } = toAnthropicRequest(
      req({
        presence_penalty: 0.5,
        frequency_penalty: 0.1,
        seed: 7,
        logit_bias: { "1": 2 },
        store: true,
        reasoning_effort: null,
        stream_options: { include_usage: true },
      }),
      options,
    );
    expect(dropped).toEqual([
      "presence_penalty",
      "frequency_penalty",
      "seed",
      "logit_bias",
      "store",
    ]);
    for (const key of dropped) expect(result).not.toHaveProperty(key);
    expect(result).not.toHaveProperty("stream_options");
  });

  it.each([
    [{ type: "input_audio", input_audio: {} }, "type"],
    [{ type: "image_url", image_url: { url: "ftp://x/y.png" } }, "image_url"],
  ])("rejects unsupported content part %j", (part, where) => {
    const error = rejection(req({ messages: [user([part])] }));
    expect(error.status).toBe(400);
    expect(error.message).toContain(where);
  });

  it("rejects roles Anthropic has no equivalent for", () => {
    const error = rejection(req({ messages: [{ role: "function", name: "f", content: "x" }] }));
    expect(error.status).toBe(400);
    expect(error.message).toContain("messages[0].role");
  });
});

describe("toAnthropicRequest tools (spec 014, AC-3)", () => {
  const weather = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  };

  it("translates tools into name, description and input_schema", () => {
    expect(
      body(req({ tools: [weather, { type: "function", function: { name: "noop" } }] })).tools,
    ).toEqual([
      {
        name: "get_weather",
        description: "Weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
      { name: "noop", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it.each([
    ["auto", { type: "auto" }],
    ["none", { type: "none" }],
    ["required", { type: "any" }],
    [
      { type: "function", function: { name: "get_weather" } },
      { type: "tool", name: "get_weather" },
    ],
  ])("tool_choice %j → %j", (choice, expected) => {
    expect(body(req({ tools: [weather], tool_choice: choice })).tool_choice).toEqual(expected);
  });

  it("parallel_tool_calls: false → disable_parallel_tool_use", () => {
    expect(body(req({ tools: [weather], parallel_tool_calls: false })).tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    expect(
      body(req({ tools: [weather], tool_choice: "required", parallel_tool_calls: false }))
        .tool_choice,
    ).toEqual({ type: "any", disable_parallel_tool_use: true });
    expect(body(req({ tools: [weather], parallel_tool_calls: true }))).not.toHaveProperty(
      "tool_choice",
    );
  });

  it("rejects non-function tools", () => {
    const error = rejection(req({ tools: [{ type: "custom", custom: { name: "x" } }] }));
    expect(error.status).toBe(400);
    expect(error.message).toContain("tools[0]");
  });

  it("translates assistant tool_calls into tool_use blocks and tool messages into tool_result", () => {
    const result = body(
      req({
        messages: [
          user("Weather in Paris and Rome?"),
          {
            role: "assistant",
            content: "Checking.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
              { id: "call_2", type: "function", function: { name: "get_weather", arguments: "" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "18C" },
          { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "21C" }] },
          user("Thanks"),
        ],
      }),
    );
    expect(result.messages).toEqual([
      { role: "user", content: "Weather in Paris and Rome?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "call_2", name: "get_weather", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "18C" },
          { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "21C" }] },
          { type: "text", text: "Thanks" },
        ],
      },
    ]);
  });

  it("omits empty assistant text next to tool calls", () => {
    const result = body(
      req({
        messages: [
          user("x"),
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }],
          },
        ],
      }),
    );
    expect(result.messages).toEqual([
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "f", input: {} }] },
    ]);
  });

  it.each([["{not json"], ["[1,2]"], ['"text"']])(
    "invalid tool arguments %s → 400 invalid_tool_arguments",
    (args) => {
      const error = rejection(
        req({
          messages: [
            user("x"),
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: args } }],
            },
          ],
        }),
      );
      expect(error.status).toBe(400);
      expect(error.code).toBe("invalid_tool_arguments");
      expect(error.message).toContain("messages[1].tool_calls[0]");
    },
  );
});
