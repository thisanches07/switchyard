import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { createProviderRegistry } from "../../../src/modules/providers/registry.js";
import { testConfig } from "../../helpers/config.js";
import { fakeHttp, jsonResponse } from "../../helpers/http.js";

const request = { model: "m", messages: [{ role: "user", content: "hi" }] };
const ctx = () => ({ signal: new AbortController().signal });
const ok = { object: "chat.completion", model: "m", choices: [] };

function providerOf(registry: ReadonlyMap<string, ChatProvider>, name: string): ChatProvider {
  const provider = registry.get(name);
  if (!provider) throw new Error(`missing provider ${name}`);
  return provider;
}

async function gatewayError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected GatewayError");
}

describe("createProviderRegistry", () => {
  it("builds one adapter per configured provider", () => {
    const registry = createProviderRegistry(
      testConfig(),
      {},
      { http: fakeHttp(() => jsonResponse(200, ok)).client },
    );
    expect([...registry.keys()].sort()).toEqual(["claude", "mock", "ollama", "openrouter"]);
    expect(registry.get("mock")?.type).toBe("mock");
    expect(registry.get("ollama")?.type).toBe("openai-compatible");
  });

  it("anthropic providers return 501 until implemented", async () => {
    const registry = createProviderRegistry(
      testConfig(),
      { ANTHROPIC_API_KEY: "sk-ant" },
      {
        http: fakeHttp(() => jsonResponse(200, ok)).client,
      },
    );
    const error = await gatewayError(providerOf(registry, "claude").chat(request, ctx()));
    expect(error.status).toBe(501);
    expect(error.code).toBe("provider_not_implemented");
  });

  it("missing API key → 503 naming the variable, provider never called", async () => {
    const http = fakeHttp(() => jsonResponse(200, ok));
    const registry = createProviderRegistry(testConfig(), {}, { http: http.client });
    const error = await gatewayError(providerOf(registry, "openrouter").chat(request, ctx()));
    expect(error.status).toBe(503);
    expect(error.message).toContain("OPENROUTER_API_KEY");
    expect(http.calls).toHaveLength(0);
  });

  it("uses the key from the environment when set", async () => {
    const http = fakeHttp(() => jsonResponse(200, ok));
    const registry = createProviderRegistry(
      testConfig(),
      { OPENROUTER_API_KEY: "sk-or-secret" },
      { http: http.client },
    );
    await providerOf(registry, "openrouter").chat(request, ctx());
    expect(http.calls[0]?.headers.authorization).toBe("Bearer sk-or-secret");
  });
});
