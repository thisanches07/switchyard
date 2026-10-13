/**
 * Official Anthropic TypeScript SDK against Switchyard's `/v1/messages` (spec 014, AC-16):
 * cross-family on the mock provider and same-family on the in-process fake Anthropic server.
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyViaAdmin } from "../helpers/admin.js";
import { type GatewayUnderTest, startAnthropicGateway } from "../helpers/anthropic-gateway.js";
import { FAKE_TEXT, type FakeAnthropic, startFakeAnthropic } from "../helpers/fake-anthropic.js";
import { TEST_ADMIN_TOKEN } from "../helpers/memory-key-store.js";

const MOCK_TEXT = "This is a mock response.";
const tools: Anthropic.Tool[] = [
  {
    name: "get_weather",
    description: "Current weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } } },
  },
];

describe("official Anthropic TypeScript SDK against Switchyard", () => {
  let fake: FakeAnthropic;
  let gateway: GatewayUnderTest;
  let client: Anthropic;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    gateway = await startAnthropicGateway(fake.url);
    const key = await createKeyViaAdmin(gateway.origin, TEST_ADMIN_TOKEN);
    client = new Anthropic({ baseURL: gateway.origin, apiKey: key, maxRetries: 0 });
  });
  afterAll(async () => {
    await gateway?.close();
    await fake?.close();
  });

  /** create → tool_use → tool_result → final text, through the SDK's own types. */
  async function toolRoundTrip(model: string) {
    const question: Anthropic.MessageParam = { role: "user", content: "Weather in Paris?" };
    const first = await client.messages.create({
      model,
      max_tokens: 200,
      tools,
      messages: [question],
    });
    expect(first.stop_reason).toBe("tool_use");
    const toolUse = first.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    expect(toolUse?.name).toBe("get_weather");
    if (!toolUse) return undefined;
    const second = await client.messages.create({
      model,
      max_tokens: 200,
      tools,
      messages: [
        question,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "18C and sunny" }],
        },
      ],
    });
    expect(second.stop_reason).toBe("end_turn");
    return second.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  }

  describe.each([
    ["mock provider (cross-family)", "fast", MOCK_TEXT],
    ["fake Anthropic server (same-family)", "smart", FAKE_TEXT],
  ])("%s", (_label, model, expectedText) => {
    it("creates a message", async () => {
      const { data, response, request_id } = await client.messages
        .create({ model, max_tokens: 100, messages: [{ role: "user", content: "Say hi" }] })
        .withResponse();
      expect(data.type).toBe("message");
      expect(data.model).toBe(model);
      expect(data.content).toEqual([{ type: "text", text: expectedText }]);
      expect(data.usage.output_tokens).toBeGreaterThan(0);
      expect(request_id).toBe(response.headers.get("x-switchyard-request-id"));
    });

    it("streams a message (events and finalMessage)", async () => {
      const stream = client.messages.stream({
        model,
        max_tokens: 100,
        messages: [{ role: "user", content: "Say hi" }],
      });
      let text = "";
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      expect(text).toBe(expectedText);
      expect(types[0]).toBe("message_start");
      expect(types.at(-1)).toBe("message_stop");
      expect(final.content).toEqual([{ type: "text", text: expectedText }]);
      expect(final.stop_reason).toBe("end_turn");
      expect(final.usage.output_tokens).toBeGreaterThan(0);
    });

    it("completes a tool-use round trip", async () => {
      expect(await toolRoundTrip(model)).toBe(expectedText);
    });

    it("streams a tool call the SDK can parse", async () => {
      const stream = client.messages.stream({
        model,
        max_tokens: 200,
        tools,
        messages: [{ role: "user", content: "Weather in Paris?" }],
      });
      const final = await stream.finalMessage();
      expect(final.stop_reason).toBe("tool_use");
      const toolUse = final.content.find((b) => b.type === "tool_use");
      expect(toolUse).toMatchObject({ type: "tool_use", name: "get_weather" });
      expect(typeof (toolUse as Anthropic.ToolUseBlock).input).toBe("object");
    });
  });

  it("surfaces an invalid key as AuthenticationError", async () => {
    const anonymous = new Anthropic({
      baseURL: gateway.origin,
      apiKey: "sk-sy-wrong",
      maxRetries: 0,
    });
    const error = await anonymous.messages
      .create({ model: "fast", max_tokens: 10, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.AuthenticationError);
    expect((error as InstanceType<typeof Anthropic.AuthenticationError>).type).toBe(
      "authentication_error",
    );
  });

  it("surfaces gateway rate limits as RateLimitError", async () => {
    const limitedKey = await createKeyViaAdmin(gateway.origin, TEST_ADMIN_TOKEN, {
      team: `limited-${Date.now()}`,
      rpm: 1,
    });
    const limited = new Anthropic({ baseURL: gateway.origin, apiKey: limitedKey, maxRetries: 0 });
    const params = {
      model: "fast",
      max_tokens: 10,
      messages: [{ role: "user" as const, content: "x" }],
    };
    const ok = await limited.messages.create(params).withResponse();
    expect(ok.response.headers.get("anthropic-ratelimit-requests-limit")).toBe("1");
    const error = await limited.messages.create(params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.RateLimitError);
    const headers = (error as InstanceType<typeof Anthropic.RateLimitError>).headers;
    expect(Number(headers?.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("surfaces unknown models as NotFoundError", async () => {
    const error = await client.messages
      .create({ model: "gpt-9", max_tokens: 10, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.NotFoundError);
    expect((error as InstanceType<typeof Anthropic.NotFoundError>).requestID).toMatch(/^req_/);
  });

  it.each(["mock/error-500", "claude/error-500", "claude/error-529"])(
    "surfaces upstream failures (%s) as InternalServerError",
    async (model) => {
      const error = await client.messages
        .create({ model, max_tokens: 10, messages: [{ role: "user", content: "x" }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Anthropic.InternalServerError);
    },
  );

  it("surfaces a mid-stream failure as an error while iterating", async () => {
    const stream = client.messages.stream({
      model: "claude/error-midstream",
      max_tokens: 10,
      messages: [{ role: "user", content: "x" }],
    });
    const error = await (async () => {
      try {
        for await (const _event of stream) {
          // consume until the error event
        }
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(Anthropic.APIError);
  });
});
