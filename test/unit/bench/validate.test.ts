import { describe, expect, it } from "vitest";
import {
  cacheStatus,
  checkChatCompletion,
  checkErrorBody,
  checkRetryAfter,
  checkSseStream,
  EXPECTED_CONTENT,
  header,
  missingHeaders,
  SUCCESS_HEADERS,
} from "../../../bench/k6/validate.js";
import { createMockProvider } from "../../../src/modules/providers/mock.js";

const signal = () => ({ signal: new AbortController().signal });
const request = { model: "bench", messages: [{ role: "user", content: "hi" }] };

async function mockBody(): Promise<string> {
  const provider = createMockProvider("m", { latencyMs: 0, errorRate: 0 });
  return JSON.stringify((await provider.chat(request, signal())).body);
}

async function mockStream(): Promise<string> {
  const provider = createMockProvider("m", { latencyMs: 0, errorRate: 0 });
  let text = "";
  for await (const chunk of await provider.chatStream({ ...request, stream: true }, signal())) {
    text += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  return `${text}data: [DONE]\n\n`;
}

describe("k6 correctness checks (AC-4)", () => {
  it("expects exactly what the mock provider answers", async () => {
    const body = JSON.parse(await mockBody());
    expect(body.choices[0].message.content).toBe(EXPECTED_CONTENT);
  });

  it("accepts the mock's chat completion and rejects malformed ones", async () => {
    const good = await mockBody();
    expect(checkChatCompletion(good)).toBeNull();
    expect(checkChatCompletion("<html>")).toBe("body is not JSON");
    const parsed = JSON.parse(good);
    expect(checkChatCompletion(JSON.stringify({ ...parsed, object: "x" }))).toMatch(/object/);
    parsed.choices[0].message.content = "other";
    expect(checkChatCompletion(JSON.stringify(parsed))).toBe("unexpected message content");
    expect(checkChatCompletion(JSON.stringify({ ...JSON.parse(good), usage: undefined }))).toBe(
      "missing usage",
    );
  });

  it("accepts a complete SSE stream and rejects truncated or malformed ones", async () => {
    const good = await mockStream();
    expect(checkSseStream(good)).toBeNull();
    expect(checkSseStream(`: keep-alive\n\n${good}`)).toBeNull();
    expect(checkSseStream("")).toBe("empty stream");
    expect(checkSseStream(good.replace("data: [DONE]\n\n", ""))).toBe(
      "stream does not end with [DONE]",
    );
    const events = good.split("\n\n").filter(Boolean);
    expect(checkSseStream(`${events.slice(0, 2).join("\n\n")}\n\ndata: [DONE]\n\n`)).toBe(
      "no finish_reason stop",
    );
    expect(checkSseStream(`data: {oops\n\ndata: [DONE]\n\n`)).toBe("event is not JSON");
    expect(
      checkSseStream(`data: {"error":{"message":"x","type":"server_error"}}\n\ndata: [DONE]\n\n`),
    ).toBe("error event in stream");
    expect(checkSseStream("event: x\ndata: [DONE]\n\n")).toBe("line outside a data field");
  });

  it("checks the OpenAI error shape", () => {
    const body = { error: { message: "Too many requests", type: "rate_limit_error", code: "x" } };
    expect(checkErrorBody(JSON.stringify(body))).toBeNull();
    expect(checkErrorBody(JSON.stringify({ error: { ...body.error, code: null } }))).toBeNull();
    expect(checkErrorBody(JSON.stringify({ message: "x" }))).toMatch(/lacks/);
    expect(checkErrorBody("nope")).toMatch(/not JSON/);
    expect(checkErrorBody(JSON.stringify({ error: { ...body.error, code: 5 } }))).toMatch(/code/);
  });

  it("requires retry-after of at least one second on 429", () => {
    expect(checkRetryAfter({ "Retry-After": "3" })).toBeNull();
    expect(checkRetryAfter({ "Retry-After": "0" })).toMatch(/retry-after/);
    expect(checkRetryAfter({})).toMatch(/retry-after/);
  });

  it("finds gateway headers case-insensitively and lists the missing ones", () => {
    const headers = {
      "X-Switchyard-Request-Id": "req_1",
      "X-Switchyard-Provider": "upstream",
      "X-Switchyard-Model": "bench",
    };
    expect(header(headers, "x-switchyard-model")).toBe("bench");
    expect(missingHeaders(headers, SUCCESS_HEADERS)).toEqual(["x-switchyard-attempts"]);
    expect(missingHeaders({ ...headers, "X-Switchyard-Attempts": "0" }, SUCCESS_HEADERS)).toEqual(
      [],
    );
  });

  it("classifies the cache header", () => {
    expect(cacheStatus({ "X-Switchyard-Cache": "hit" })).toBe("hit");
    expect(cacheStatus({ "X-Switchyard-Cache": "miss" })).toBe("miss");
    expect(cacheStatus({})).toBe("absent");
    expect(cacheStatus({ "X-Switchyard-Cache": "bypass" })).toBe("invalid");
  });
});
