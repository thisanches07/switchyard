import type { LoadedConfig, ResolvedProvider } from "../../config/load.js";
import { providerNotConfigured } from "../../core/errors.js";
import type { ChatProvider, HttpClient } from "../../core/provider.js";
import { ANTHROPIC_BASE_URL, createAnthropicProvider } from "./anthropic.js";
import { createMockProvider } from "./mock.js";
import { createFailingProvider } from "./not-implemented.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

export interface RegistryDeps {
  http: HttpClient;
  random?: () => number;
}

export type ProviderRegistry = ReadonlyMap<string, ChatProvider>;

export function createProviderRegistry(
  config: Pick<LoadedConfig, "providers">,
  env: Record<string, string | undefined>,
  deps: RegistryDeps,
): ProviderRegistry {
  const registry = new Map<string, ChatProvider>();
  for (const [name, provider] of Object.entries(config.providers)) {
    registry.set(name, buildProvider(name, provider, env, deps));
  }
  return registry;
}

function buildProvider(
  name: string,
  provider: ResolvedProvider,
  env: Record<string, string | undefined>,
  deps: RegistryDeps,
): ChatProvider {
  switch (provider.type) {
    case "mock":
      return createMockProvider(
        name,
        {
          latencyMs: provider.latencyMs,
          errorRate: provider.errorRate,
          chunkDelayMs: provider.chunkDelayMs,
        },
        deps.random ? { random: deps.random } : {},
      );
    case "anthropic": {
      const { apiKeyEnv } = provider;
      const apiKey = env[apiKeyEnv];
      if (!apiKey) {
        return createFailingProvider(name, provider.type, () =>
          providerNotConfigured(name, apiKeyEnv),
        );
      }
      return createAnthropicProvider(
        {
          name,
          baseUrl: provider.baseUrl ?? ANTHROPIC_BASE_URL,
          apiKey,
          defaultMaxTokens: provider.defaultMaxTokens,
        },
        deps.http,
      );
    }
    case "openai-compatible": {
      const { apiKeyEnv } = provider;
      const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
      if (apiKeyEnv && !apiKey) {
        // Not a boot failure: example configs list providers the operator may not use.
        return createFailingProvider(name, provider.type, () =>
          providerNotConfigured(name, apiKeyEnv),
        );
      }
      return createOpenAiCompatibleProvider({ name, baseUrl: provider.baseUrl, apiKey }, deps.http);
    }
  }
}
