import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { failingCheck, okCheck } from "../../helpers/checks.js";

describe("health routes", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it("GET /healthz returns ok", async () => {
    const { app } = await testApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("unknown route returns OpenAI-style 404", async () => {
    const { app } = await testApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        message: "Route GET /nope not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  it("health requests are not logged at info level", async () => {
    const { app, logs } = await testApp();
    apps.push(app);
    await app.inject({ method: "GET", url: "/healthz" });
    expect(logs.filter((l) => l.msg === "request completed")).toHaveLength(0);
  });
});

describe("readiness route", () => {
  it("GET /readyz returns 200 when all dependencies are up", async () => {
    const { app } = await testApp({ checks: [okCheck("postgres"), okCheck("redis")] });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  });

  it("GET /readyz returns 503 with failing list", async () => {
    const { app } = await testApp({ checks: [okCheck("postgres"), failingCheck("redis")] });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "not_ready",
      checks: { postgres: "ok", redis: "error" },
      failing: ["redis"],
    });
  });
});
