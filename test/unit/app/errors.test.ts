import { afterEach, describe, expect, it } from "vitest";
import { invalidRequest } from "../../../src/core/errors.js";
import { testApp } from "../../helpers/app.js";

describe("app error handling", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function appWithRoutes(bodyLimitBytes?: number) {
    const { app, logs } = await testApp(bodyLimitBytes ? { bodyLimitBytes } : {});
    app.post("/test/echo", async (request) => request.body);
    app.get("/test/gateway-error", async () => {
      throw invalidRequest("messages: Required");
    });
    app.get("/test/boom", async () => {
      throw new Error("database password is hunter2");
    });
    apps.push(app);
    return { app, logs };
  }

  it("invalid JSON → 400 invalid_json", async () => {
    const { app } = await appWithRoutes();
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: "invalid_request_error", code: "invalid_json" });
  });

  it("oversized body → 413 request_too_large", async () => {
    const { app } = await appWithRoutes(64);
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ text: "x".repeat(200) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("request_too_large");
  });

  it("unsupported content type → 415", async () => {
    const { app } = await appWithRoutes();
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "text/plain" },
      payload: "hello",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("GatewayError → its status and OpenAI body", async () => {
    const { app } = await appWithRoutes();
    const res = await app.inject({ method: "GET", url: "/test/gateway-error" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        message: "messages: Required",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
  });

  it("unexpected error → 500 with a generic message, details only in logs", async () => {
    const { app, logs } = await appWithRoutes();
    const res = await app.inject({ method: "GET", url: "/test/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { message: "Internal server error", type: "server_error", code: "internal_error" },
    });
    expect(res.body).not.toContain("hunter2");
    expect(logs.some((l) => l.msg === "unhandled error")).toBe(true);
  });

  it("every response carries x-switchyard-request-id", async () => {
    const { app } = await appWithRoutes();
    const ok = await app.inject({ method: "GET", url: "/healthz" });
    const err = await app.inject({ method: "GET", url: "/test/boom" });
    const missing = await app.inject({ method: "GET", url: "/nope" });
    for (const res of [ok, err, missing]) {
      expect(res.headers["x-switchyard-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/);
    }
    expect(ok.headers["x-switchyard-request-id"]).not.toBe(err.headers["x-switchyard-request-id"]);
  });
});
