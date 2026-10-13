import { afterEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../../../src/config/load.js";
import { configSchema } from "../../../src/config/schema.js";
import { testApp } from "../../helpers/app.js";
import { spiedRegistry } from "../../helpers/providers.js";

const config = configSchema.parse({
  providers: {
    mock: { type: "mock" },
    ollama: { type: "openai-compatible", baseUrl: "http://ollama.test/v1" },
    openrouter: { type: "openai-compatible", baseUrl: "http://or.test/v1" },
    claude: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
  aliases: { embed: { strategy: "priority", candidates: ["mock/nomic-embed-text"] } },
}) as LoadedConfig;

type Body = { object: string; data: { index: number; embedding: number[] }[]; usage: unknown };

describe("POST /v1/embeddings", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function post(payload: unknown) {
    const { registry, spies } = spiedRegistry();
    const { app } = await testApp({ providers: registry, config });
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: payload as object,
    });
    return { res, spies };
  }

  it("resolves an alias and returns one embedding per input with headers", async () => {
    const { res, spies } = await post({ model: "embed", input: ["a", "b"] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body.object).toBe("list");
    expect(body.data.map((d) => d.index)).toEqual([0, 1]);
    expect(body.data[0]?.embedding).toHaveLength(768);
    expect(spies.mock?.embeddingRequests[0]).toEqual({
      model: "nomic-embed-text",
      input: ["a", "b"],
    });
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(res.headers["x-switchyard-model"]).toBe("nomic-embed-text");
    expect(res.headers["x-switchyard-upstream-ms"]).toMatch(/^\d+$/);
  });

  it("accepts a single string and passes other fields through", async () => {
    const { res, spies } = await post({
      model: "mock/e",
      input: "hello",
      encoding_format: "float",
      dimensions: 768,
    });
    expect(res.statusCode).toBe(200);
    expect(spies.mock?.embeddingRequests[0]).toEqual({
      model: "e",
      input: "hello",
      encoding_format: "float",
      dimensions: 768,
    });
  });

  it.each([
    [{ input: "x" }, "model"],
    [{ model: "embed" }, "input"],
    [{ model: "embed", input: [] }, "input"],
    [{ model: "embed", input: 42 }, "input"],
  ])("invalid body %j → 400 naming %s", async (payload, field) => {
    const { res } = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain(field);
  });

  it("unknown model → 404 and no provider call", async () => {
    const { res, spies } = await post({ model: "text-embedding-9", input: "x" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("model_not_found");
    expect(spies.mock?.embeddingRequests).toHaveLength(0);
  });

  it("maps upstream failures", async () => {
    const { res } = await post({ model: "mock/error-503", input: "x" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_error");
  });
});
