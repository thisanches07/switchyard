import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { spiedRegistry } from "../../helpers/providers.js";

const messages = [{ role: "user", content: "hello" }];

describe("POST /v1/chat/completions", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup() {
    const { registry, spies } = spiedRegistry();
    const { app } = await testApp({ providers: registry });
    apps.push(app);
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url: "/v1/chat/completions", payload: payload as object });
    return { app, spies, post };
  }

  it("alias resolves to the first candidate and returns the completion", async () => {
    const { spies, post } = await setup();
    const res = await post({ model: "fast", messages, temperature: 0.1 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ object: "chat.completion", model: "fast-model" });
    expect(spies.mock?.requests[0]).toEqual({ model: "fast-model", messages, temperature: 0.1 });
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(res.headers["x-switchyard-model"]).toBe("fast-model");
    expect(res.headers["x-switchyard-upstream-ms"]).toMatch(/^\d+$/);
    expect(res.headers["x-switchyard-request-id"]).toMatch(/^req_/);
  });

  it("direct provider/model keeps slashes in the model id", async () => {
    const { spies, post } = await setup();
    const res = await post({ model: "openrouter/meta-llama/llama-3.3-70b", messages });
    expect(res.statusCode).toBe(200);
    expect(spies.openrouter?.requests[0]?.model).toBe("meta-llama/llama-3.3-70b");
    expect(res.headers["x-switchyard-provider"]).toBe("openrouter");
  });

  it("unknown model → 404 model_not_found and no provider is called", async () => {
    const { spies, post } = await setup();
    const res = await post({ model: "gpt-9", messages });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "model_not_found",
    });
    expect(Object.values(spies).every((s) => s.requests.length === 0)).toBe(true);
    expect(res.headers["x-switchyard-provider"]).toBeUndefined();
  });

  it.each([
    [{ messages }, "model"],
    [{ model: "fast" }, "messages"],
    [{ model: "fast", messages: [] }, "messages"],
    [{ model: "fast", messages: [{ content: "no role" }] }, "messages[0].role"],
    [{ model: 42, messages }, "model"],
  ])("invalid body %j → 400 naming %s", async (body, field) => {
    const { post } = await setup();
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(res.json().error.message).toContain(field);
  });

  it("stream: true → 400 stream_not_supported", async () => {
    const { post } = await setup();
    const res = await post({ model: "fast", messages, stream: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("stream_not_supported");
  });

  it("upstream failure keeps provider headers and maps the error", async () => {
    const { post } = await setup();
    const res = await post({ model: "mock/error-500", messages });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_error");
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(res.headers["x-switchyard-model"]).toBe("error-500");
    expect(res.headers["x-switchyard-upstream-ms"]).toMatch(/^\d+$/);
  });

  it("upstream 429 is passed through", async () => {
    const { post } = await setup();
    const res = await post({ model: "mock/error-429", messages });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limit_exceeded");
  });
});

describe("GET /v1/models", () => {
  it("lists aliases and provider/model candidates", async () => {
    const { registry } = spiedRegistry();
    const { app } = await testApp({ providers: registry });
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: { id: string }) => m.id)).toEqual([
      "local",
      "fast",
      "smart",
      "ollama/llama3.2",
      "mock/fast-model",
      "openrouter/meta-llama/llama-3.3-70b",
    ]);
    expect(body.data[0].created).toBeTypeOf("number");
  });
});
