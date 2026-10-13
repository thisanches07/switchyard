import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureText } from "../helpers/anthropic-fixtures.js";
import { type GatewayUnderTest, startAnthropicGateway } from "../helpers/anthropic-gateway.js";
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_TEXT,
  type FakeAnthropic,
  startFakeAnthropic,
} from "../helpers/fake-anthropic.js";

/** Spec 014, AC-15: the adapter over real HTTP against an in-process fake Anthropic server. */
describe("anthropic adapter against a fake Anthropic server", () => {
  let fake: FakeAnthropic;
  let gateway: GatewayUnderTest;
  let key: string;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    gateway = await startAnthropicGateway(fake.url);
    ({ key } = await gateway.store.issueKey());
  });
  afterAll(async () => {
    await gateway?.close();
    await fake?.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${gateway.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("AC-1 to AC-3: sends the documented headers and a translated body", async () => {
    const res = await post("/v1/chat/completions", {
      model: "smart",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather in Paris?" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: {} } },
        },
      ],
      tool_choice: "auto",
      seed: 1,
    });
    expect(res.status).toBe(200);
    const recorded = fake.requests.at(-1);
    expect(recorded?.headers["x-api-key"]).toBe(FAKE_ANTHROPIC_KEY);
    expect(recorded?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(recorded?.headers["content-type"]).toBe("application/json");
    expect(recorded?.body).toEqual({
      model: "claude-fake",
      system: "Be brief.",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      max_tokens: 4096,
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "auto" },
    });
    const body = (await res.json()) as {
      choices: { message: { content: string; tool_calls: unknown[] }; finish_reason: string }[];
      usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } };
    };
    expect(body.choices[0]?.message.content).toBe("Let me check.");
    expect(body.choices[0]?.message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^toolu_fake_/),
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.usage).toMatchObject({
      prompt_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  it("AC-10: streams chat completion chunks ending with [DONE]", async () => {
    const res = await post("/v1/chat/completions", {
      model: "smart",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .filter((e) => e.startsWith("data: ") && e !== "data: [DONE]")
      .map(
        (e) =>
          JSON.parse(e.slice(6)) as { choices: { delta: { content?: string } }[]; usage?: unknown },
      );
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe(FAKE_TEXT);
    expect(chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 15, completion_tokens: 5 });
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it.each([
    ["claude/error-429", 429, "upstream_rate_limited"],
    ["claude/error-529", 503, "upstream_overloaded"],
    ["claude/error-500", 502, "upstream_error"],
  ])("AC-13: %s → %i %s", async (model, status, code) => {
    const res = await post("/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    if (status === 429) expect(res.headers.get("retry-after")).toBe("7");
  });

  it("AC-12: an error event after content ends the OpenAI stream with an error event", async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude/error-midstream",
      messages: [{ role: "user", content: "x" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content":"Partial"');
    expect(text).toContain('"code":"upstream_overloaded"');
    expect(text).not.toContain("[DONE]");
  });

  it("AC-7: /v1/messages same-family sends the client bytes with only the model changed", async () => {
    const raw = fixtureText("request-same-family.json");
    const client = { ...JSON.parse(raw), model: "smart" };
    const res = await post("/v1/messages", client, { "x-api-key": key });
    expect(res.status).toBe(200);
    expect(fake.requests.at(-1)?.raw).toBe(JSON.stringify({ ...client, model: "claude-fake" }));
    const message = (await res.json()) as { model: string; id: string; content: unknown[] };
    expect(message.model).toBe("smart");
    expect(message.id).toMatch(/^msg_fake_/);
  });

  it("AC-11: /v1/messages same-family streams the upstream events", async () => {
    const res = await post("/v1/messages", {
      model: "smart",
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("event: message_start\n")).toBe(true);
    expect(text).toContain('"model":"smart"');
    expect(text).toContain("event: ping");
    expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });
});
