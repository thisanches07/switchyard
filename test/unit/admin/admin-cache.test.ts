import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

describe("admin API: semantic cache opt-in (spec 009, AC-1)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup() {
    const { app, store } = await testApp({ authenticated: false, adminToken: TEST_ADMIN_TOKEN });
    apps.push(app);
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: admin,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const team = (await call("POST", "/admin/teams", { name: "cached" })).json() as { id: string };
    return { store, call, team };
  }

  it("creates keys opted out by default, or opted in", async () => {
    const { call, team } = await setup();
    const plain = await call("POST", "/admin/keys", { teamId: team.id, name: "plain" });
    expect(plain.statusCode).toBe(201);
    expect(plain.json()).toMatchObject({ semanticCacheEnabled: false });
    const opted = await call("POST", "/admin/keys", {
      teamId: team.id,
      name: "opted",
      semanticCacheEnabled: true,
    });
    expect(opted.json()).toMatchObject({ semanticCacheEnabled: true });
    const listed = (await call("GET", `/admin/keys?teamId=${team.id}`)).json() as {
      data: { name: string; semanticCacheEnabled: boolean }[];
    };
    expect(listed.data.map((k) => [k.name, k.semanticCacheEnabled])).toEqual([
      ["plain", false],
      ["opted", true],
    ]);
  });

  it("changes the opt-in with PATCH, leaving other settings alone", async () => {
    const { call, team, store } = await setup();
    const key = (
      await call("POST", "/admin/keys", { teamId: team.id, name: "k", rpm: 7, piiMode: "mask" })
    ).json() as { id: string };
    const on = await call("PATCH", `/admin/keys/${key.id}`, { semanticCacheEnabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ semanticCacheEnabled: true, rpm: 7, piiMode: "mask" });
    expect((await store.getKey(key.id))?.semanticCacheEnabled).toBe(true);
    const off = await call("PATCH", `/admin/keys/${key.id}`, { semanticCacheEnabled: false });
    expect(off.json()).toMatchObject({ semanticCacheEnabled: false, rpm: 7 });
  });

  it.each([
    ["POST", { name: "k", semanticCacheEnabled: "yes" }],
    ["POST", { name: "k", semanticCacheEnabled: null }],
    ["PATCH", { semanticCacheEnabled: 1 }],
    ["PATCH", { semanticCacheEnabled: null }],
  ] as const)(
    "rejects an invalid semanticCacheEnabled on %s %j with 400",
    async (method, payload) => {
      const { call, team } = await setup();
      const key = (await call("POST", "/admin/keys", { teamId: team.id, name: "base" })).json() as {
        id: string;
      };
      const res =
        method === "POST"
          ? await call("POST", "/admin/keys", { teamId: team.id, ...payload })
          : await call("PATCH", `/admin/keys/${key.id}`, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain("semanticCacheEnabled");
    },
  );
});
