// Runs the Python SDK contract suites (spec 003 AC-13, spec 014 AC-16): starts the gateway
// in-process with the mock provider, a fake Anthropic server (and Ollama when available), then
// runs pytest against it.
// Usage: pnpm test:contract:py   (Python with `openai`, `anthropic` and `pytest` installed; see
// test/contract/python/requirements.txt). Set SWITCHYARD_PYTHON to pick an interpreter.
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import type { LoadedConfig } from "../src/config/load.js";
import { configSchema } from "../src/config/schema.js";
import { createUndiciClient } from "../src/infra/http/undici-client.js";
import { createLogger } from "../src/infra/logger.js";
import { MemoryRateLimiter } from "../src/infra/memory/rate-limiter.js";
import { createProviderRegistry } from "../src/modules/providers/registry.js";
import { createKeyViaAdmin } from "../test/helpers/admin.js";
import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from "../test/helpers/fake-anthropic.js";
import { MemoryKeyStore, TEST_ADMIN_TOKEN, TEST_PEPPER } from "../test/helpers/memory-key-store.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
const PYTHON = process.env.SWITCHYARD_PYTHON ?? "python";

async function ollamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

const models = await ollamaModels();
const has = (name: string) => models.some((id) => id === name || id.startsWith(`${name}:`));
// Spec 014: an in-process fake of the Anthropic API serves the `claude` provider (no paid key).
const fakeAnthropic = await startFakeAnthropic();

const config = configSchema.parse({
  server: { timeouts: { connectMs: 2_000, ttfbMs: 120_000, totalMs: 180_000 } },
  providers: {
    mock: { type: "mock" },
    ollama: { type: "openai-compatible", baseUrl: OLLAMA_BASE_URL },
    claude: { type: "anthropic", baseUrl: fakeAnthropic.url, apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
  aliases: {
    fast: { strategy: "priority", candidates: ["mock/fast-model"] },
    smart: { strategy: "priority", candidates: ["claude/claude-fake"] },
    local: { strategy: "priority", candidates: [`ollama/${OLLAMA_MODEL}`] },
    embed: { strategy: "priority", candidates: [`ollama/${OLLAMA_EMBED_MODEL}`] },
  },
  // Spec 009: exact cache for temperature-0 requests (in-process store).
  cache: { exact: { enabled: true } },
}) as LoadedConfig;

const http = createUndiciClient(config.server.timeouts);
const store = new MemoryKeyStore();
const app = await buildApp({
  logger: createLogger({ level: "silent" }),
  checks: [],
  config,
  providers: createProviderRegistry(config, { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY }, { http }),
  rateLimiter: new MemoryRateLimiter(),
  keyStore: store,
  keyPepper: TEST_PEPPER,
  adminToken: TEST_ADMIN_TOKEN,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const { port } = app.server.address() as AddressInfo;
// Spec 004, AC-11: the SDK authenticates with a key issued through the admin API.
const key = await createKeyViaAdmin(`http://127.0.0.1:${port}`, TEST_ADMIN_TOKEN);
// Spec 005: a key limited to one request per minute.
const limitedKey = await createKeyViaAdmin(`http://127.0.0.1:${port}`, TEST_ADMIN_TOKEN, {
  team: "limited",
  rpm: 1,
});
const anthropicLimitedKey = await createKeyViaAdmin(`http://127.0.0.1:${port}`, TEST_ADMIN_TOKEN, {
  team: "limited-anthropic",
  rpm: 1,
});

// Spec 007: a key whose monthly budget is 0, so every request is rejected with budget_exceeded.
const budgetKey = await createKeyViaAdmin(`http://127.0.0.1:${port}`, TEST_ADMIN_TOKEN, {
  team: "budget-exhausted",
  monthlyBudgetUsd: 0,
});

const root = resolve(import.meta.dirname, "..");
const code = await new Promise<number>((done) => {
  const child = spawn(PYTHON, ["-m", "pytest", "test/contract/python", "-q", "-rs"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      SWITCHYARD_BASE_URL: `http://127.0.0.1:${port}/v1`,
      // The Anthropic SDK appends /v1/messages itself.
      SWITCHYARD_ORIGIN: `http://127.0.0.1:${port}`,
      SWITCHYARD_API_KEY: key,
      SWITCHYARD_LIMITED_KEY: limitedKey,
      SWITCHYARD_BUDGET_KEY: budgetKey,
      SWITCHYARD_ANTHROPIC_LIMITED_KEY: anthropicLimitedKey,
      OLLAMA_CHAT: has(OLLAMA_MODEL) ? "1" : "0",
      OLLAMA_EMBED: has(OLLAMA_EMBED_MODEL) ? "1" : "0",
    },
  });
  child.on("exit", (exitCode) => done(exitCode ?? 1));
  child.on("error", (error) => {
    console.error(`Could not start "${PYTHON}": ${error.message}`);
    done(1);
  });
});

await app.close();
await http.close();
await fakeAnthropic.close();
process.exit(code);
