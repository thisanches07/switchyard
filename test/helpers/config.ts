import type { LoadedConfig } from "../../src/config/load.js";
import { configSchema } from "../../src/config/schema.js";

/** A small valid config; providers already resolved (as `loadConfig` returns them). */
export function testConfig(overrides: Partial<Record<string, unknown>> = {}): LoadedConfig {
  const parsed = configSchema.parse({
    providers: {
      mock: { type: "mock" },
      ollama: { type: "openai-compatible", baseUrl: "http://ollama.test/v1" },
      openrouter: {
        type: "openai-compatible",
        baseUrl: "http://openrouter.test/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      claude: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
    },
    aliases: {
      local: { strategy: "priority", candidates: ["ollama/llama3.2"] },
      fast: { strategy: "priority", candidates: ["mock/fast-model", "ollama/llama3.2"] },
      smart: { strategy: "priority", candidates: ["openrouter/meta-llama/llama-3.3-70b"] },
    },
    ...overrides,
  });
  return parsed as LoadedConfig;
}
