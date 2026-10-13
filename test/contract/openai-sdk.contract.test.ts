import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { LoadedConfig } from "../../src/config/load.js";
import { configSchema } from "../../src/config/schema.js";
import { createUndiciClient } from "../../src/infra/http/undici-client.js";
import { createLogger } from "../../src/infra/logger.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { createKeyViaAdmin } from "../helpers/admin.js";
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
}) as LoadedConfig;

describe("official OpenAI Node SDK against Switchyard", () => {
  let app: FastifyInstance;
  let client: OpenAI;
  const http = createUndiciClient(config.server.timeouts);
  const store = new MemoryKeyStore();
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config,
      providers: createProviderRegistry(config, {}, { http }),
      keyStore: store,
      keyPepper: TEST_PEPPER,
      adminToken: TEST_ADMIN_TOKEN,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    // AC-11: the SDK authenticates with a key issued through the admin API.
    const key = await createKeyViaAdmin(baseUrl, TEST_ADMIN_TOKEN);
    client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: key,
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

if (!ollamaChat || !ollamaEmbed) {
  const reason = models ? "model(s) not pulled" : `Ollama not reachable at ${OLLAMA_BASE_URL}`;
  console.warn(
    `[contract] Some Ollama cases skipped (${reason}). ` +
      `Run "ollama pull ${OLLAMA_MODEL}" and "ollama pull ${OLLAMA_EMBED_MODEL}" to include them.`,
  );
}
