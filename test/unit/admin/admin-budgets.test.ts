import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

describe("admin API: budgets (spec 007, AC-4)", () => {
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
    const team = (await call("POST", "/admin/teams", { name: "budgeted" })).json() as {
      id: string;
    };
    return { app, store, call, team };
  }

  it("creates teams with a budget and a soft limit; defaults are no budget and 80 %", async () => {
    const { call, team } = await setup();
    expect((await call("GET", "/admin/teams")).json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: team.id, monthlyBudgetUsd: null, softLimitPct: 80 }),
      ]),
    );
    const res = await call("POST", "/admin/teams", {
      name: "capped",
      monthlyBudgetUsd: 250.5,
      softLimitPct: 90,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ monthlyBudgetUsd: "250.5", softLimitPct: 90 });
  });

  it("creates keys with a budget given as a number or a decimal string, normalized", async () => {
    const { call, team } = await setup();
    const asNumber = await call("POST", "/admin/keys", {
      teamId: team.id,
      name: "a",
      monthlyBudgetUsd: 10,
    });
    expect(asNumber.statusCode).toBe(201);
    expect(asNumber.json().monthlyBudgetUsd).toBe("10");
    const asString = await call("POST", "/admin/keys", {
      teamId: team.id,
      name: "b",
      monthlyBudgetUsd: "0.5000",
    });
    expect(asString.json().monthlyBudgetUsd).toBe("0.5");
    const none = await call("POST", "/admin/keys", { teamId: team.id, name: "c" });
    expect(none.json().monthlyBudgetUsd).toBeNull();
    const list = (await call("GET", `/admin/keys?teamId=${team.id}`)).json() as {
      data: { monthlyBudgetUsd: string | null }[];
    };
    expect(list.data.map((k) => k.monthlyBudgetUsd)).toEqual(["10", "0.5", null]);
  });

  it.each([
    ["negative", -1],
    ["negative string", "-0.01"],
    ["5 decimal places", "1.00001"],
    ["5 decimal places as a number", 0.00001],
    ["too large", "100000000"],
    ["too large number", 1e9],
    ["exponent string", "1e3"],
    ["garbage", "ten"],
    ["empty", ""],
    ["boolean", true],
    ["object", { usd: 1 }],
  ])("rejects a %s budget with 400 invalid_request", async (_label, value) => {
    const { call, team } = await setup();
    const res = await call("POST", "/admin/keys", {
      teamId: team.id,
      name: "x",
      monthlyBudgetUsd: value,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(res.json().error.message).toContain("monthlyBudgetUsd");
    const patched = await call("PATCH", `/admin/teams/${team.id}`, { monthlyBudgetUsd: value });
    expect(patched.statusCode).toBe(400);
  });

  it("accepts the bounds 0 and 99999999.9999", async () => {
    const { call, team } = await setup();
    for (const value of [0, "0", "99999999.9999", 99999999.9999]) {
      const res = await call("PATCH", `/admin/teams/${team.id}`, { monthlyBudgetUsd: value });
      expect(res.statusCode).toBe(200);
    }
    expect(
      (await call("PATCH", `/admin/teams/${team.id}`, { monthlyBudgetUsd: 0 })).json(),
    ).toMatchObject({ monthlyBudgetUsd: "0" });
  });

  it.each([0, 101, 50.5, "80", null])("rejects softLimitPct %j", async (value) => {
    const { call, team } = await setup();
    const res = await call("PATCH", `/admin/teams/${team.id}`, { softLimitPct: value });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("softLimitPct");
  });

  it("patches a team's budget or soft limit alone, and null clears the budget", async () => {
    const { call, team } = await setup();
    await call("PATCH", `/admin/teams/${team.id}`, { rpm: 100 });
    expect(
      (await call("PATCH", `/admin/teams/${team.id}`, { monthlyBudgetUsd: "75" })).json(),
    ).toMatchObject({ monthlyBudgetUsd: "75", softLimitPct: 80, rpm: 100 });
    expect(
      (await call("PATCH", `/admin/teams/${team.id}`, { softLimitPct: 95 })).json(),
    ).toMatchObject({ monthlyBudgetUsd: "75", softLimitPct: 95, rpm: 100 });
    expect(
      (await call("PATCH", `/admin/teams/${team.id}`, { monthlyBudgetUsd: null })).json(),
    ).toMatchObject({ monthlyBudgetUsd: null, softLimitPct: 95 });
    expect((await call("PATCH", `/admin/teams/${team.id}`, {})).statusCode).toBe(400);
  });

  it("patches a key's budget alone, keeps its other settings, and drops the cached key", async () => {
    const { app, call, team, store } = await setup();
    const created = (
      await call("POST", "/admin/keys", { teamId: team.id, name: "k", rpm: 5, piiMode: "mask" })
    ).json() as { id: string; key: string };
    const useKey = () =>
      app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { authorization: `Bearer ${created.key}` },
      });
    await useKey();
    await useKey();
    const lookups = store.lookups;

    const res = await call("PATCH", `/admin/keys/${created.id}`, { monthlyBudgetUsd: 12.25 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ monthlyBudgetUsd: "12.25", rpm: 5, piiMode: "mask" });
    await useKey();
    expect(store.lookups).toBe(lookups + 1);

    expect(
      (await call("PATCH", `/admin/keys/${created.id}`, { monthlyBudgetUsd: null })).json(),
    ).toMatchObject({ monthlyBudgetUsd: null, rpm: 5 });
  });
});
