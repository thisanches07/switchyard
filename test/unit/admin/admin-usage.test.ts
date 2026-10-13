import { afterEach, describe, expect, it } from "vitest";
import type { UsageQuery, UsageReader } from "../../../src/core/usage.js";
import { testApp } from "../../helpers/app.js";
import { TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
const TEAM = "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";

describe("GET /admin/usage (spec 006, AC-11)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(reader?: UsageReader) {
    const { app } = await testApp({
      authenticated: false,
      adminToken: TEST_ADMIN_TOKEN,
      ...(reader ? { usageReader: reader } : {}),
    });
    apps.push(app);
    return (url: string, headers: Record<string, string> = admin) =>
      app.inject({ method: "GET", url, headers });
  }

  function fakeReader() {
    const queries: UsageQuery[] = [];
    const reader: UsageReader = {
      async summarize(query) {
        queries.push(query);
        return {
          data: [
            {
              group: "mock/fast-model",
              requests: 3,
              inputTokens: 30,
              outputTokens: 9,
              costUsd: "0.0012000",
              unknownCostRequests: 1,
            },
            {
              group: null,
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: "0.000",
              unknownCostRequests: 1,
            },
          ],
          totals: {
            requests: 4,
            inputTokens: 30,
            outputTokens: 9,
            costUsd: "0.00120",
            unknownCostRequests: 2,
          },
        };
      },
    };
    return { reader, queries };
  }

  it("returns grouped usage, totals and the effective range", async () => {
    const { reader, queries } = fakeReader();
    const get = await setup(reader);
    const res = await get(
      `/admin/usage?from=2026-10-01&to=2026-10-13&groupBy=model&teamId=${TEAM}`,
    );
    expect(res.statusCode).toBe(200);
    expect(queries).toEqual([
      { from: "2026-10-01", to: "2026-10-13", groupBy: "model", teamId: TEAM },
    ]);
    expect(res.json()).toEqual({
      from: "2026-10-01",
      to: "2026-10-13",
      groupBy: "model",
      data: [
        {
          group: "mock/fast-model",
          requests: 3,
          inputTokens: 30,
          outputTokens: 9,
          costUsd: "0.0012",
          unknownCostRequests: 1,
        },
        {
          group: null,
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: "0",
          unknownCostRequests: 1,
        },
      ],
      totals: {
        requests: 4,
        inputTokens: 30,
        outputTokens: 9,
        costUsd: "0.0012",
        unknownCostRequests: 2,
      },
    });
  });

  it("uses the default range and grouping", async () => {
    const { reader, queries } = fakeReader();
    const get = await setup(reader);
    const res = await get("/admin/usage");
    expect(res.statusCode).toBe(200);
    expect(queries[0]?.groupBy).toBe("day");
    expect(res.json().to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    "/admin/usage?from=yesterday",
    "/admin/usage?groupBy=week",
    "/admin/usage?from=2026-10-02&to=2026-10-01",
    "/admin/usage?from=2024-01-01&to=2026-01-01",
    "/admin/usage?keyId=nope",
  ])("answers 400 invalid_request for %s", async (url) => {
    const get = await setup(fakeReader().reader);
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("requires the admin token", async () => {
    const get = await setup(fakeReader().reader);
    expect((await get("/admin/usage", {})).statusCode).toBe(401);
  });

  it("answers 503 when no usage store is configured", async () => {
    const get = await setup();
    const res = await get("/admin/usage");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("usage_unavailable");
  });
});
