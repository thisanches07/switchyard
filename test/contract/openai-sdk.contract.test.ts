import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { LoadedConfig } from "../../src/config/load.js";
import { configSchema } from "../../src/config/schema.js";
import { createUndiciClient } from "../../src/infra/http/undici-client.js";
import { createLogger } from "../../src/infra/logger.js";
import { MemoryRateLimiter } from "../../src/infra/memory/rate-limiter.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { createKeyViaAdmin } from "../helpers/admin.js";
import { type GatewayUnderTest, startAnthropicGateway } from "../helpers/anthropic-gateway.js";
import { FAKE_TEXT, type FakeAnthropic, startFakeAnthropic } from "../helpers/fake-anthropic.js";
import { MemoryKeyStore, TEST_ADMIN_TOKEN, TEST_PEPPER } from "../helpers/memory-key-store.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

/** Model ids served by Ollama, or undefined when Ollama is not reachable. */
async function ollamaModels(): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  } catch {
    return undefined;
  }
}
const models = await ollamaModels();
const hasModel = (name: string) =>
  models?.some((id) => id === name || id.startsWith(`${name}:`)) ?? false;
const ollamaChat = hasModel(OLLAMA_MODEL);
const ollamaEmbed = hasModel(OLLAMA_EMBED_MODEL);

const config = configSchema.parse({
  server: { timeouts: { connectMs: 2_000, ttfbMs: 120_000, totalMs: 180_000 } },
  providers: {
    mock: { type: "mock" },
    ollama: { type: "openai-compatible", baseUrl: OLLAMA_BASE_URL },
  },
  aliases: {
    fast: { strategy: "priority", candidates: ["mock/fast-model"] },
    local: { strategy: "priority", candidates: [`ollama/${OLLAMA_MODEL}`] },
    embed: { strategy: "priority", candidates: [`ollama/${OLLAMA_EMBED_MODEL}`] },
  },
  // Spec 009: exact cache for temperature-0 requests (in-process store).
  cache: { exact: { enabled: true } },
}) as LoadedConfig;

describe("official OpenAI Node SDK against Switchyard", () => {
  let app: FastifyInstance;
  let client: OpenAI;
  const http = createUndiciClient(config.server.timeouts);
  const store = new MemoryKeyStore();
  let baseUrl: string;
  let apiKey: string;

  beforeAll(async () => {
    app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config,
      providers: createProviderRegistry(config, {}, { http }),
      rateLimiter: new MemoryRateLimiter(),
      keyStore: store,
      keyPepper: TEST_PEPPER,
      adminToken: TEST_ADMIN_TOKEN,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    // AC-11: the SDK authenticates with a key issued through the admin API.
    apiKey = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN);
    client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey,
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await app?.close();
    await http.close();
  });

  it("completes a chat through an alias (mock provider)", async () => {
    const { data, response } = await client.chat.completions
      .create({ model: "fast", messages: [{ role: "user", content: "Say hi" }] })
      .withResponse();

    expect(data.choices[0]?.message.content).toBe("This is a mock response.");
    expect(data.usage?.completion_tokens).toBe(6);
    expect(response.headers.get("x-switchyard-provider")).toBe("mock");
    expect(response.headers.get("x-switchyard-request-id")).toMatch(/^req_/);
  });

  it("surfaces an invalid key as AuthenticationError", async () => {
    const anonymous = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: "sk-sy-wrong",
      maxRetries: 0,
    });
    const error = await anonymous.models.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.AuthenticationError);
  });

  it("surfaces gateway rate limits as RateLimitError with rate limit headers (spec 005)", async () => {
    const limitedKey = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN, {
      team: `limited-${Date.now()}`,
      rpm: 1,
    });
    const limited = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: limitedKey, maxRetries: 0 });
    const ok = await limited.chat.completions
      .create({ model: "fast", messages: [{ role: "user", content: "hi" }] })
      .withResponse();
    expect(ok.response.headers.get("x-ratelimit-limit-requests")).toBe("1");
    const error = await limited.chat.completions
      .create({ model: "fast", messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
    const headers = (error as InstanceType<typeof OpenAI.RateLimitError>).headers;
    expect(Number(headers?.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("surfaces an exhausted budget as RateLimitError budget_exceeded, not retried (spec 007)", async () => {
    const budgetKey = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN, {
      team: `budget-${Date.now()}`,
      monthlyBudgetUsd: 0,
    });
    let calls = 0;
    // Default maxRetries (2): x-should-retry: false must stop the SDK from retrying the 429.
    const budgeted = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: budgetKey,
      fetch: (input, init) => {
        calls += 1;
        return fetch(input, init);
      },
    });
    const error = await budgeted.chat.completions
      .create({ model: "fast", messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
    const rateLimit = error as InstanceType<typeof OpenAI.RateLimitError>;
    expect(rateLimit.status).toBe(429);
    expect(rateLimit.code).toBe("budget_exceeded");
    expect(rateLimit.type).toBe("insufficient_quota");
    expect(rateLimit.headers?.get("x-switchyard-budget-remaining-usd")).toBe("0");
    expect(calls).toBe(1);
  });

  it("surfaces a PII block as BadRequestError with code pii_detected (spec 010)", async () => {
    const blockKey = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN, {
      team: `pii-block-${Date.now()}`,
      piiMode: "block",
    });
    const blocked = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: blockKey, maxRetries: 0 });
    const error = await blocked.chat.completions
      .create({ model: "fast", messages: [{ role: "user", content: "CPF 529.982.247-25" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.BadRequestError);
    const badRequest = error as InstanceType<typeof OpenAI.BadRequestError>;
    expect(badRequest.code).toBe("pii_detected");
    expect(badRequest.message).toContain("cpf");
    expect(badRequest.message).not.toContain("529.982.247-25");
  });

  it("restores masked values in a non-streaming answer (spec 010)", async () => {
    const maskKey = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN, {
      team: `pii-mask-${Date.now()}`,
      piiMode: "mask",
    });
    const masked = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: maskKey, maxRetries: 0 });
    const { data, response } = await masked.chat.completions
      .create({ model: "mock/echo", messages: [{ role: "user", content: "CPF 529.982.247-25" }] })
      .withResponse();
    expect(response.headers.get("x-switchyard-pii")).toBe("masked");
    expect(data.choices[0]?.message.content).toBe("CPF 529.982.247-25");
  });

  it("restores masked values in a streamed answer (spec 015)", async () => {
    const maskKey = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN, {
      team: `pii-mask-stream-${Date.now()}`,
      piiMode: "mask",
    });
    const masked = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: maskKey, maxRetries: 0 });
    const { data: stream, response } = await masked.chat.completions
      .create({
        model: "mock/echo",
        messages: [{ role: "user", content: "CPF 529.982.247-25" }],
        stream: true,
      })
      .withResponse();
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
    expect(response.headers.get("x-switchyard-pii")).toBe("masked");
    // `mock/echo` streams "CPF <CPF_1>" in three pieces, splitting the placeholder.
    expect(text).toBe("CPF 529.982.247-25");
  });

  it("lists models", async () => {
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    expect(ids).toEqual(expect.arrayContaining(["fast", "local", "embed", "mock/fast-model"]));
  });

  it("surfaces unknown models as NotFoundError", async () => {
    const error = await client.chat.completions
      .create({ model: "gpt-9", messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.NotFoundError);
    expect((error as InstanceType<typeof OpenAI.NotFoundError>).code).toBe("model_not_found");
  });

  it("surfaces upstream rate limits as RateLimitError", async () => {
    const error = await client.chat.completions
      .create({ model: "mock/error-429", messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
  });

  it("streams a chat completion through an alias (mock provider)", async () => {
    const stream = await client.chat.completions.create({
      model: "fast",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toBe("This is a mock response.");
    expect(usage?.completion_tokens).toBe(6);
  });

  it("surfaces a mid-stream failure as an error while iterating", async () => {
    const stream = await client.chat.completions.create({
      model: "mock/error-midstream",
      messages: [{ role: "user", content: "x" }],
      stream: true,
    });
    const error = await (async () => {
      try {
        for await (const _chunk of stream) {
          // consume until the error event
        }
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(OpenAI.APIError);
  });

  it("creates embeddings with the SDK default (base64) encoding", async () => {
    const res = await client.embeddings.create({ model: "mock/embed", input: ["a", "b"] });
    expect(res.data).toHaveLength(2);
    expect(res.data[0]?.embedding).toHaveLength(768);
    expect(typeof res.data[0]?.embedding[0]).toBe("number");
  });

  it("creates embeddings with explicit float encoding", async () => {
    const res = await client.embeddings.create({
      model: "mock/embed",
      input: "a",
      encoding_format: "float",
    });
    expect(res.data[0]?.embedding).toHaveLength(768);
    expect(res.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it.skipIf(!ollamaChat)(
    `completes a chat on Ollama (${OLLAMA_MODEL})`,
    async () => {
      const data = await client.chat.completions.create({
        model: "local",
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        temperature: 0,
      });
      expect(data.choices[0]?.message.content?.length ?? 0).toBeGreaterThan(0);
      expect(data.usage?.prompt_tokens ?? 0).toBeGreaterThan(0);
    },
    180_000,
  );

  it.skipIf(!ollamaChat)(
    `streams a chat on Ollama (${OLLAMA_MODEL})`,
    async () => {
      const stream = await client.chat.completions.create({
        model: "local",
        messages: [{ role: "user", content: "Count from 1 to 5." }],
        stream: true,
        stream_options: { include_usage: true },
      });
      let chunks = 0;
      let usage: OpenAI.CompletionUsage | null | undefined;
      for await (const chunk of stream) {
        chunks += 1;
        if (chunk.usage) usage = chunk.usage;
      }
      expect(chunks).toBeGreaterThan(2);
      expect(usage?.completion_tokens ?? 0).toBeGreaterThan(0);
    },
    180_000,
  );

  it.each([
    ["text", {}],
    [
      "tool calls",
      { tools: [{ type: "function" as const, function: { name: "lookup", parameters: {} } }] },
    ],
  ])(
    "reads a streamed cache hit of %s like any stream (spec 009, AC-7, AC-13)",
    async (name, extra) => {
      const seen: (string | null)[] = [];
      const cached = new OpenAI({
        baseURL: `${baseUrl}/v1`,
        apiKey,
        maxRetries: 0,
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          seen.push(res.headers.get("x-switchyard-cache"));
          return res;
        },
      });
      const params = {
        model: "fast",
        temperature: 0,
        messages: [{ role: "user" as const, content: `cache me: ${name}` }],
        ...extra,
      };
      const stored = await cached.chat.completions.create(params);
      const final = await cached.chat.completions
        .stream({ ...params, stream_options: { include_usage: true } })
        .finalChatCompletion();
      expect(seen).toEqual(["miss", "hit"]);
      const [want, got] = [stored.choices[0], final.choices[0]];
      expect(got?.message.content ?? null).toEqual(want?.message.content ?? null);
      expect(got?.message.tool_calls ?? []).toEqual(want?.message.tool_calls ?? []);
      expect(got?.finish_reason).toBe(want?.finish_reason);
      expect(final.usage).toMatchObject({
        prompt_tokens: stored.usage?.prompt_tokens,
        completion_tokens: stored.usage?.completion_tokens,
      });
    },
  );

  it.skipIf(!ollamaEmbed)(
    `creates embeddings on Ollama (${OLLAMA_EMBED_MODEL})`,
    async () => {
      const res = await client.embeddings.create({ model: "embed", input: ["hello", "world"] });
      expect(res.data).toHaveLength(2);
      expect(res.data[0]?.embedding.length).toBe(768);
    },
    180_000,
  );
});

describe("official OpenAI Node SDK routed to an Anthropic provider (spec 014, AC-16)", () => {
  let fake: FakeAnthropic;
  let gateway: GatewayUnderTest;
  let anthropicClient: OpenAI;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    gateway = await startAnthropicGateway(fake.url);
    const key = await createKeyViaAdmin(gateway.origin, TEST_ADMIN_TOKEN);
    anthropicClient = new OpenAI({ baseURL: `${gateway.origin}/v1`, apiKey: key, maxRetries: 0 });
  });
  afterAll(async () => {
    await gateway?.close();
    await fake?.close();
  });

  it("completes a chat", async () => {
    const res = await anthropicClient.chat.completions.create({
      model: "smart",
      messages: [{ role: "user", content: "Say hi" }],
    });
    expect(res.choices[0]?.message.content).toBe(FAKE_TEXT);
    expect(res.choices[0]?.finish_reason).toBe("stop");
    expect(res.usage?.prompt_tokens_details?.cached_tokens).toBe(3);
    expect(fake.requests.at(-1)?.body).toMatchObject({ model: "claude-fake", max_tokens: 4096 });
  });

  it("streams a chat with usage", async () => {
    const stream = await anthropicClient.chat.completions.create({
      model: "smart",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toBe(FAKE_TEXT);
    expect(usage?.completion_tokens).toBe(5);
  });

  it("returns tool calls, streamed and not, and accepts the tool result", async () => {
    const tools: OpenAI.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    const ask: OpenAI.ChatCompletionMessageParam = { role: "user", content: "Weather in Paris?" };
    const first = await anthropicClient.chat.completions.create({
      model: "smart",
      messages: [ask],
      tools,
    });
    const call = first.choices[0]?.message.tool_calls?.[0];
    expect(first.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call?.type === "function" && JSON.parse(call.function.arguments)).toEqual({
      city: "Paris",
    });

    const stream = await anthropicClient.chat.completions.create({
      model: "smart",
      messages: [ask],
      tools,
      stream: true,
    });
    let args = "";
    for await (const chunk of stream) {
      args += chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? "";
    }
    expect(JSON.parse(args)).toEqual({ city: "Paris" });

    if (!call) return;
    const final = await anthropicClient.chat.completions.create({
      model: "smart",
      tools,
      messages: [
        ask,
        first.choices[0]?.message as OpenAI.ChatCompletionMessageParam,
        { role: "tool", tool_call_id: call.id, content: "18C" },
      ],
    });
    expect(final.choices[0]?.message.content).toBe(FAKE_TEXT);
    expect(fake.requests.at(-1)?.body.messages).toEqual([
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: call.id, name: "get_weather", input: { city: "Paris" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "18C" }] },
    ]);
  });
});

if (!ollamaChat || !ollamaEmbed) {
  const reason = models ? "model(s) not pulled" : `Ollama not reachable at ${OLLAMA_BASE_URL}`;
  console.warn(
    `[contract] Some Ollama cases skipped (${reason}). ` +
      `Run "ollama pull ${OLLAMA_MODEL}" and "ollama pull ${OLLAMA_EMBED_MODEL}" to include them.`,
  );
}
