import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";

describe("OpenAPI documentation", () => {
  let app: Awaited<ReturnType<typeof testApp>>["app"];
  beforeAll(async () => {
    ({ app } = await testApp({ adminToken: TEST_ADMIN_TOKEN, authenticated: false }));
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves an OpenAPI 3 document covering /v1 and the admin API", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      openapi: string;
      paths: Record<string, unknown>;
      components: unknown;
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/v1/chat/completions",
        "/v1/embeddings",
        "/v1/models",
        "/admin/teams",
        "/admin/keys",
        "/admin/keys/{id}/revoke",
      ]),
    );
    expect(JSON.stringify(doc.components)).toContain("bearer");
  });

  it("serves the interactive UI", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("route schemas do not filter provider responses (ADR-0014)", async () => {
    const { app: authed } = await testApp();
    const res = await authed.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", messages: [{ role: "user", content: "hi" }], unknown_field: 1 },
    });
    await authed.close();
    expect(res.statusCode).toBe(200);
    // The mock body includes fields no schema declares; they must survive serialisation.
    expect(res.json()).toHaveProperty("usage.total_tokens");
    expect(res.json()).toHaveProperty("choices.0.finish_reason", "stop");
  });
});
