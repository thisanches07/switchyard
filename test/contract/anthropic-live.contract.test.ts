/**
 * Optional live test against the real Anthropic API (spec 014, AC-15). Runs only when both
 * ANTHROPIC_API_KEY and SWITCHYARD_LIVE_ANTHROPIC=1 are set; costs a few cents per run.
 * SWITCHYARD_LIVE_ANTHROPIC_MODEL picks the model (default: the example config's Claude model).
 *
 * The tool-loop case answers the spec's open question on thinking blocks: it fails if the model
 * rejects an OpenAI-surface tool continuation whose assistant turn lost its thinking blocks.
 */
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
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
import { MemoryKeyStore, TEST_PEPPER } from "../helpers/memory-key-store.js";

const enabled =
  Boolean(process.env.ANTHROPIC_API_KEY) && process.env.SWITCHYARD_LIVE_ANTHROPIC === "1";
const MODEL = process.env.SWITCHYARD_LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

if (!enabled) {
  console.warn(
    "[contract] Live Anthropic test skipped: set ANTHROPIC_API_KEY and SWITCHYARD_LIVE_ANTHROPIC=1 to run it (uses a paid key).",
  );
}

describe.skipIf(!enabled)(`live Anthropic API (${MODEL})`, () => {
  let app: FastifyInstance;
  let origin: string;
  let key: string;
  const config = configSchema.parse({
    server: { timeouts: { connectMs: 5_000, ttfbMs: 60_000, totalMs: 120_000 } },
    providers: {
      claude: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", defaultMaxTokens: 512 },
    },
  }) as LoadedConfig;
  const http = createUndiciClient(config.server.timeouts);

  beforeAll(async () => {
    const store = new MemoryKeyStore();
    app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config,
      providers: createProviderRegistry(config, process.env, { http }),
      rateLimiter: new MemoryRateLimiter(),
      keyStore: store,
      keyPepper: TEST_PEPPER,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    ({ key } = await store.issueKey());
  });
  afterAll(async () => {
    await app?.close();
    await http.close();
  });

  it("answers through /v1/chat/completions (OpenAI SDK)", async () => {
    const client = new OpenAI({ baseURL: `${origin}/v1`, apiKey: key, maxRetries: 0 });
    const res = await client.chat.completions.create({
      model: `claude/${MODEL}`,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      max_tokens: 64,
    });
    expect(res.choices[0]?.message.content?.length ?? 0).toBeGreaterThan(0);
    expect(res.usage?.prompt_tokens ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("answers through /v1/messages (Anthropic SDK)", async () => {
    const client = new Anthropic({ baseURL: origin, apiKey: key, maxRetries: 0 });
    const message = await client.messages.create({
      model: `claude/${MODEL}`,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    });
    expect(message.content.some((b) => b.type === "text")).toBe(true);
  }, 120_000);

  it("completes a tool loop through /v1/chat/completions (thinking open question)", async () => {
    const client = new OpenAI({ baseURL: `${origin}/v1`, apiKey: key, maxRetries: 0 });
    const tools: OpenAI.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "What is the weather in Paris? Use the tool." },
    ];
    const first = await client.chat.completions.create({
      model: `claude/${MODEL}`,
      messages,
      tools,
      max_tokens: 512,
    });
    const call = first.choices[0]?.message.tool_calls?.[0];
    expect(call).toBeDefined();
    if (!call) return;
    messages.push(first.choices[0]?.message as OpenAI.ChatCompletionMessageParam);
    messages.push({ role: "tool", tool_call_id: call.id, content: "18C and sunny" });
    const second = await client.chat.completions.create({
      model: `claude/${MODEL}`,
      messages,
      tools,
      max_tokens: 512,
    });
    expect(second.choices[0]?.message.content?.length ?? 0).toBeGreaterThan(0);
  }, 180_000);
});
