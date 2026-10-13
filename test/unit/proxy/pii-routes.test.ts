import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatChunk, ChatRequest } from "../../../src/core/chat.js";
import type { PiiMode, PiiRequestResult } from "../../../src/core/pii.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { MemoryKeyStore, TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";
import { spyProvider } from "../../helpers/providers.js";

const CPF = "529.982.247-25";
const EMAIL = "ana.silva@example.com";

/** Text of the last user message (string content only). */
function lastUserText(request: ChatRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

/** A provider that answers with what it received, as content and as tool-call arguments. */
const echoProvider: ChatProvider = {
  name: "mock",
  type: "mock",
  async chat(request) {
    const text = lastUserText(request);
    return {
      body: {
        id: "chatcmpl-echo",
        object: "chat.completion",
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `You said: ${text}`,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "save", arguments: JSON.stringify({ text }) },
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      },
      usage: { inputTokens: 3, outputTokens: 3 },
    };
  },
  async chatStream(request) {
    const text = lastUserText(request);
    const chunk = (delta: object, finish: string | null): ChatChunk => ({
      id: "chatcmpl-echo",
      object: "chat.completion.chunk",
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return (async function* () {
      yield chunk({ role: "assistant", content: "" }, null);
      yield chunk({ content: text }, null);
      yield chunk({}, "stop");
    })();
  },
  async embeddings(request) {
    return {
      body: { object: "list", data: [], model: request.model },
      usage: { inputTokens: 1 },
    };
  },
};

interface Setup {
  defaultMode?: PiiMode;
  keyMode?: PiiMode | null;
  denyList?: string[];
}

describe("PII redaction on /v1 routes (spec 010)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup({ defaultMode = "off", keyMode = null, denyList = [] }: Setup = {}) {
    const store = new MemoryKeyStore();
    const limiter = new MemoryRateLimiter();
    const spy = spyProvider(echoProvider);
    const config = testConfig({ pii: { defaultMode, denyList } });
    const { app } = await testApp({
      store,
      limiter,
      config,
      providers: new Map([["mock", spy.provider]]),
      authenticated: false,
    });
    apps.push(app);
    const seen: (PiiRequestResult | undefined)[] = [];
    app.addHook("onResponse", async (request: FastifyRequest) => {
      seen.push(request.pii);
    });
    const { key, record } = await store.issueKey({
      piiMode: keyMode,
      limits: { rpm: 100, tpm: 10_000 },
    });
    const call = (url: string, payload: object) =>
      app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${key}` } });
    const chat = (content: string, extra: object = {}) =>
      call("/v1/chat/completions", {
        model: "mock/echo",
        messages: [{ role: "user", content }],
        ...extra,
      });
    const tokensLeft = () => limiter.peek(`sy:rl:key:${record.id}:tok`, 10_000);
    const requestsLeft = () => limiter.peek(`sy:rl:key:${record.id}:req`, 100);
    return { app, spy, seen, call, chat, tokensLeft, requestsLeft };
  }

  describe("mask", () => {
    it("sends placeholders upstream and restores the non-streaming answer (AC-7, AC-8)", async () => {
      const { spy, seen, chat } = await setup({ keyMode: "mask" });
      const res = await chat(`My CPF is ${CPF}, mail ${EMAIL}, CPF again ${CPF}`);

      expect(res.statusCode).toBe(200);
      expect(spy.requests[0]?.messages).toEqual([
        { role: "user", content: "My CPF is <CPF_1>, mail <EMAIL_1>, CPF again <CPF_1>" },
      ]);
      const message = res.json().choices[0].message;
      expect(message.content).toBe(`You said: My CPF is ${CPF}, mail ${EMAIL}, CPF again ${CPF}`);
      expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({
        text: `My CPF is ${CPF}, mail ${EMAIL}, CPF again ${CPF}`,
      });
      expect(res.json().usage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
      expect(res.headers["x-switchyard-pii"]).toBe("masked");
      expect(seen[0]).toEqual({ mode: "mask", action: "masked", detections: { cpf: 2, email: 1 } });
    });

    it("forwards streamed chunks with placeholders and says so (AC-9)", async () => {
      const { spy, chat } = await setup({ keyMode: "mask" });
      const res = await chat(`CPF ${CPF}`, { stream: true });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
      expect(res.headers["x-switchyard-pii"]).toBe("masked-unrestored");
      expect(spy.requests[0]?.messages[0]?.content).toBe("CPF <CPF_1>");
      expect(res.body).toContain("CPF <CPF_1>");
      expect(res.body).not.toContain(CPF);
      expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    });

    it("masks embeddings input (AC-7)", async () => {
      const { spy, call } = await setup({ keyMode: "mask" });
      const res = await call("/v1/embeddings", { model: "mock/e", input: [`cpf ${CPF}`, EMAIL] });
      expect(res.statusCode).toBe(200);
      expect(spy.embeddingRequests[0]?.input).toEqual(["cpf <CPF_1>", "<EMAIL_1>"]);
      expect(res.headers["x-switchyard-pii"]).toBe("masked");
    });

    it("masks deny-list terms from the config", async () => {
      const { spy, chat } = await setup({ keyMode: "mask", denyList: ["Project Falcon"] });
      const res = await chat("status of project falcon?");
      expect(spy.requests[0]?.messages[0]?.content).toBe("status of <TERM_1>?");
      expect(res.json().choices[0].message.content).toBe("You said: status of project falcon?");
    });

    it("answers none and forwards the request unchanged when nothing is found (AC-10)", async () => {
      const { spy, seen, chat } = await setup({ keyMode: "mask" });
      const res = await chat("hello there");
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("none");
      expect(spy.requests[0]?.messages[0]?.content).toBe("hello there");
      expect(seen[0]).toEqual({ mode: "mask", action: "none", detections: {} });
    });
  });

  describe("off", () => {
    it("does not scan, does not send the header and forwards the original (AC-10)", async () => {
      const { spy, seen, chat } = await setup();
      const res = await chat(`CPF ${CPF}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers).not.toHaveProperty("x-switchyard-pii");
      expect(spy.requests[0]?.messages[0]?.content).toBe(`CPF ${CPF}`);
      expect(seen[0]).toEqual({ mode: "off", action: "none", detections: {} });
    });

    it("lets a key's own mode override the config default", async () => {
      const { spy, chat } = await setup({ defaultMode: "block", keyMode: "off" });
      const res = await chat(`CPF ${CPF}`);
      expect(res.statusCode).toBe(200);
      expect(spy.requests[0]?.messages[0]?.content).toBe(`CPF ${CPF}`);
    });

    it("applies an admin PATCH of the key's mode to the next request (AC-2)", async () => {
      const store = new MemoryKeyStore();
      const { app } = await testApp({
        store,
        providers: new Map([["mock", echoProvider]]),
        authenticated: false,
        adminToken: TEST_ADMIN_TOKEN,
      });
      apps.push(app);
      const { key, record } = await store.issueKey();
      const chat = () =>
        app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}` },
          payload: { model: "mock/echo", messages: [{ role: "user", content: `CPF ${CPF}` }] },
        });
      expect((await chat()).statusCode).toBe(200); // config default off; key now cached
      const patched = await app.inject({
        method: "PATCH",
        url: `/admin/keys/${record.id}`,
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
        payload: { piiMode: "block" },
      });
      expect(patched.statusCode).toBe(200);
      const blocked = await chat();
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error.code).toBe("pii_detected");
    });

    it("uses the config default for keys without a mode", async () => {
      const { spy, chat } = await setup({ defaultMode: "mask" });
      await chat(`CPF ${CPF}`);
      expect(spy.requests[0]?.messages[0]?.content).toBe("CPF <CPF_1>");
    });
  });

  describe("block (AC-11)", () => {
    const expectBlocked = (res: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["chat"]>>) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: {
          type: "invalid_request_error",
          code: "pii_detected",
          message: expect.stringContaining("(cpf, email)"),
        },
      });
      expect(res.body).not.toContain(CPF);
      expect(res.body).not.toContain(EMAIL);
      expect(res.headers["x-switchyard-pii"]).toBe("blocked");
    };

    it.each([
      ["chat", false],
      ["streaming chat", true],
    ])("refuses %s with types only, no provider call, tokens refunded", async (_l, stream) => {
      const { spy, seen, chat, tokensLeft, requestsLeft } = await setup({ keyMode: "block" });
      const res = await chat(`mail ${EMAIL} cpf ${CPF}`, stream ? { stream: true } : {});
      expectBlocked(res);
      expect(spy.requests).toHaveLength(0);
      expect(await tokensLeft()).toBeCloseTo(10_000, 0);
      expect(await requestsLeft()).toBeCloseTo(99, 0);
      expect(seen[0]).toEqual({
        mode: "block",
        action: "blocked",
        detections: { cpf: 1, email: 1 },
      });
    });

    it("refuses embeddings too", async () => {
      const { spy, call } = await setup({ keyMode: "block" });
      const res = await call("/v1/embeddings", { model: "mock/e", input: `${CPF} ${EMAIL}` });
      expectBlocked(res);
      expect(spy.embeddingRequests).toHaveLength(0);
    });

    it("lets clean requests through with x-switchyard-pii: none", async () => {
      const { chat } = await setup({ keyMode: "block" });
      const res = await chat("nothing personal");
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("none");
    });

    it("passes token-array embeddings through, flagged as uninspected", async () => {
      const { seen, call } = await setup({ keyMode: "block" });
      const res = await call("/v1/embeddings", { model: "mock/e", input: [[1, 2, 3]] });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-switchyard-pii"]).toBe("none");
      expect(seen[0]).toEqual({ mode: "block", action: "none", detections: {}, uninspected: true });
    });
  });
});
