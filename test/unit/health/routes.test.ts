import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";

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
