import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { LoadedConfig } from "../../src/config/load.js";
import { configSchema } from "../../src/config/schema.js";
import { createUndiciClient } from "../../src/infra/http/undici-client.js";
import { createLogger } from "../../src/infra/logger.js";
import { MemoryRateLimiter } from "../../src/infra/memory/rate-limiter.js";
import { createProviderRegistry } from "../../src/modules/providers/registry.js";
import { FAKE_ANTHROPIC_KEY } from "./fake-anthropic.js";
import { MemoryKeyStore, TEST_ADMIN_TOKEN, TEST_PEPPER } from "./memory-key-store.js";

export interface GatewayUnderTest {
  app: FastifyInstance;
  /** `http://127.0.0.1:<port>` (no `/v1`). */
  origin: string;
  store: MemoryKeyStore;
  close(): Promise<void>;
}

/**
 * A real gateway on a socket with a `mock` provider and a `claude` provider pointed at the fake
 * Anthropic server (spec 014). Aliases: `fast` → mock, `smart` → claude.
 */
export async function startAnthropicGateway(fakeAnthropicUrl: string): Promise<GatewayUnderTest> {
  const config = configSchema.parse({
    server: { timeouts: { connectMs: 2_000, ttfbMs: 10_000, totalMs: 20_000 } },
    providers: {
      mock: { type: "mock" },
      claude: { type: "anthropic", baseUrl: fakeAnthropicUrl, apiKeyEnv: "ANTHROPIC_API_KEY" },
    },
    aliases: {
      fast: { strategy: "priority", candidates: ["mock/fast-model"] },
      smart: { strategy: "priority", candidates: ["claude/claude-fake"] },
    },
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
  return {
    app,
    origin: `http://127.0.0.1:${port}`,
    store,
    async close() {
      await app.close();
      await http.close();
    },
  };
}
