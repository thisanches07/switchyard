import { describe, expect, it } from "vitest";
import type { ChatChunk } from "../../../src/core/chat.js";
import { assembleCompletion, cacheableBody, rechunk } from "../../../src/modules/cache/chunks.js";

const completion = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "fast-model",
  choices,
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  ...extra,
});

const textChoice = (content: string, finish = "stop", index = 0) => ({
  index,
  message: { role: "assistant", content },
  finish_reason: finish,
});

const toolChoice = {
  index: 0,
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "weather", arguments: '{"city":"Rio"}' },
      },
      { id: "call_2", type: "function", function: { name: "time", arguments: "{}" } },
    ],
  },
  finish_reason: "tool_calls",
};

describe("cacheableBody (spec 009, AC-4)", () => {
  it.each(["stop", "length", "tool_calls"])("accepts finish_reason %s", (finish) => {
    expect(cacheableBody(completion([textChoice("a", finish)]))).toBe(true);
  });

  it.each([
    ["content_filter", completion([textChoice("a", "content_filter")])],
    ["a null finish_reason", completion([textChoice("a", null as unknown as string)])],
    ["one bad choice of two", completion([textChoice("a"), textChoice("b", "content_filter", 1)])],
    ["no choices", completion([])],
    ["not an object", "text"],
    ["choices not an array", { choices: {} }],
  ])("rejects %s", (_name, body) => {
    expect(cacheableBody(body)).toBe(false);
  });
});

describe("assembleCompletion (spec 009, AC-4)", () => {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): ChatChunk => ({
    id: "chatcmpl-9",
    object: "chat.completion.chunk",
    created: 1_700_000_001,
    model: "fast-model",
    choices,
    ...extra,
  });

  it("joins content deltas, keeps finish_reason and the usage chunk", () => {
    const body = assembleCompletion([
      chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: "Hel" }, finish_reason: null }]),
      chunk([{ index: 0, delta: { content: "lo" }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
      chunk([], { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
    ]);
    expect(body).toEqual({
      id: "chatcmpl-9",
      object: "chat.completion",
      created: 1_700_000_001,
      model: "fast-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });

  it("merges tool call deltas by index", () => {
    const body = assembleCompletion([
      chunk([
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "weather", arguments: "" },
              },
            ],
          },
        },
      ]),
      chunk([
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } },
      ]),
      chunk([
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Rio"}' } }] } },
      ]),
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call_2",
                type: "function",
                function: { name: "time", arguments: "{}" },
              },
            ],
          },
        },
      ]),
      chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
    ]);
    expect(body?.choices).toEqual([{ ...toolChoice, logprobs: null }]);
    expect(body).not.toHaveProperty("usage");
  });

  it("keeps several choices in index order and the system fingerprint", () => {
    const body = assembleCompletion([
      chunk([{ index: 1, delta: { role: "assistant", content: "b" } }], {
        system_fingerprint: "fp",
      }),
      chunk([{ index: 0, delta: { role: "assistant", content: "a" } }]),
      chunk([
        { index: 0, delta: {}, finish_reason: "stop" },
        { index: 1, delta: {}, finish_reason: "length" },
      ]),
    ]);
    expect(body?.system_fingerprint).toBe("fp");
    expect(body?.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "a" },
        finish_reason: "stop",
        logprobs: null,
      },
      {
        index: 1,
        message: { role: "assistant", content: "b" },
        finish_reason: "length",
        logprobs: null,
      },
    ]);
  });

  it("is undefined without any choice", () => {
    expect(assembleCompletion([])).toBeUndefined();
    expect(assembleCompletion([chunk([], { usage: { prompt_tokens: 1 } })])).toBeUndefined();
  });
});

describe("rechunk (spec 009, AC-7)", () => {
  const usage = { inputTokens: 5, outputTokens: 3 };

  it("streams each choice then a usage-only chunk, with the body's id, created and model", () => {
    const chunks = rechunk(completion([textChoice("Hello")]), usage);
    expect(chunks).toEqual([
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "fast-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "fast-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "fast-model",
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ]);
  });

  it("builds the usage chunk from the stored usage when the body has none", () => {
    const { usage: _u, ...withoutUsage } = completion([textChoice("x")]);
    const last = rechunk(withoutUsage, { inputTokens: 7, outputTokens: 2 }).at(-1);
    expect(last?.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  });

  it.each([
    ["text", completion([textChoice("Hello world", "length")])],
    ["tool calls", completion([toolChoice])],
    [
      "two choices",
      completion([textChoice("a"), textChoice("b", "stop", 1)], { system_fingerprint: "fp" }),
    ],
  ])("round-trips %s through assembleCompletion", (_name, body) => {
    expect(assembleCompletion(rechunk(body, usage))).toEqual({
      ...body,
      choices: body.choices.map((c) => ({ ...(c as object), logprobs: null })),
    });
  });
});
