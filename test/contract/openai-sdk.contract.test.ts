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

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/models`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}
const ollamaUp = await ollamaAvailable();

const config = configSchema.parse({
  server: { timeouts: { connectMs: 2_000, ttfbMs: 120_000, totalMs: 180_000 } },
  providers: {
    mock: { type: "mock" },
    ollama: { type: "openai-compatible", baseUrl: OLLAMA_BASE_URL },
  },
  aliases: {
    fast: { strategy: "priority", candidates: ["mock/fast-model"] },
    local: { strategy: "priority", candidates: [`ollama/${OLLAMA_MODEL}`] },
  },
}) as LoadedConfig;

describe("official OpenAI Node SDK against Switchyard", () => {
  let app: FastifyInstance;
  let client: OpenAI;
  const http = createUndiciClient(config.server.timeouts);

  beforeAll(async () => {
    app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config,
      providers: createProviderRegistry(config, {}, { http }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "not-checked-until-spec-004",
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

  it("lists models", async () => {
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    expect(ids).toEqual(expect.arrayContaining(["fast", "local", "mock/fast-model"]));
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

  it.skipIf(!ollamaUp)(
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
});

if (!ollamaUp) {
  console.warn(
    `[contract] Ollama not reachable at ${OLLAMA_BASE_URL}; skipping the Ollama case. ` +
      `Start Ollama and run "ollama pull ${OLLAMA_MODEL}" to include it.`,
  );
}
