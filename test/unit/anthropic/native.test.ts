import { describe, expect, it } from "vitest";
import { anthropicExtensionOf } from "../../../src/core/anthropic.js";
import type { ChatMessage } from "../../../src/core/chat.js";
import { GatewayError } from "../../../src/core/errors.js";
import { fromAnthropicRequest } from "../../../src/modules/anthropic/inbound-request.js";
import { nativeRequestBody } from "../../../src/modules/anthropic/native.js";
import type { MessagesRequest } from "../../../src/modules/anthropic/schema.js";
import { fixtureText } from "../../helpers/anthropic-fixtures.js";

const clientBody = () => JSON.parse(fixtureText("request-same-family.json")) as MessagesRequest;

/** What a feature such as PII masking would do: replace canonical text in place. */
function mask(messages: ChatMessage[], find: string, replace: string): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages).replaceAll(find, replace)) as ChatMessage[];
}

function rebuild(body: MessagesRequest, edit?: (messages: ChatMessage[]) => ChatMessage[]) {
  const { request } = fromAnthropicRequest(body);
  const routed = { ...request, model: "claude-sonnet-5-5" };
  if (edit) routed.messages = edit(routed.messages);
  const extension = anthropicExtensionOf(routed);
  if (!extension) throw new Error("extension lost");
  return nativeRequestBody(extension, routed);
}

describe("nativeRequestBody (spec 014, AC-7)", () => {
  it("re-emits the client body byte for byte except the resolved model", () => {
    const original = fixtureText("request-same-family.json");
    const upstream = rebuild(clientBody());
    const expected = { ...JSON.parse(original), model: "claude-sonnet-5-5" };
    expect(JSON.stringify(upstream)).toBe(JSON.stringify(expected));
    // thinking, redacted_thinking, document, cache_control, server tools, top_k, metadata.
    for (const marker of [
      '"type":"thinking"',
      '"type":"redacted_thinking"',
      '"type":"document"',
      '"cache_control"',
      '"web_search_20250305"',
      '"top_k":40',
      '"user_id":"user-123"',
      '"disable_parallel_tool_use":true',
    ]) {
      expect(JSON.stringify(upstream)).toContain(marker);
    }
  });

  it("never mutates the client body", () => {
    const body = clientBody();
    const before = JSON.stringify(body);
    rebuild(body, (m) => mask(m, "Paris", "[CITY_1]"));
    expect(JSON.stringify(body)).toBe(before);
  });

  it("writes masked canonical text back into the matching blocks only", () => {
    const upstream = rebuild(clientBody(), (m) =>
      mask(mask(m, "Paris", "[CITY_1]"), "careful", "[TERM_1]"),
    ) as { system: { text: string }[]; messages: { content: Record<string, unknown>[] }[] };
    expect(upstream.system[0]?.text).toBe("You are a [TERM_1] assistant.");
    expect(upstream.messages[0]?.content[1]).toEqual({
      type: "text",
      text: "What is the weather in [CITY_1]?",
    });
    // Tool-call arguments edited in canonical form are parsed back into `input`.
    expect(upstream.messages[1]?.content[3]).toMatchObject({
      input: { city: "[CITY_1]", unit: "celsius", days: 1.5 },
    });
    // Thinking is opaque: never rewritten, so its signature stays valid.
    expect(upstream.messages[1]?.content[0]).toEqual(clientBody().messages[1]?.content[0]);
  });

  it("writes back tool_result text and string contents", () => {
    const body = clientBody();
    body.messages.push({ role: "assistant", content: "Paris is nice." });
    const upstream = rebuild(body, (m) => mask(m, "Paris", "[CITY_1]").map((x) => x)) as {
      messages: { content: unknown }[];
    };
    expect(upstream.messages[3]?.content).toBe("[CITY_1] is nice.");
    const sunny = rebuild(clientBody(), (m) => mask(m, "sunny", "[X]")) as {
      messages: { content: { content: { text: string }[] }[] }[];
    };
    expect(sunny.messages[2]?.content[0]?.content[0]?.text).toBe("18C and [X]");
  });

  it("rejects edited arguments that are no longer a JSON object", () => {
    let error: unknown;
    try {
      rebuild(clientBody(), (messages) => {
        const calls = messages[3]?.tool_calls as { function: { arguments: string } }[] | undefined;
        const call = calls?.[0];
        if (call) call.function.arguments = "{broken";
        return messages;
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("invalid_tool_arguments");
  });
});
