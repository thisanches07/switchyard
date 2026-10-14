import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdminApi,
  DEMO_KEY_DEFAULTS,
  type DemoKeyOptions,
  ensureDemoKey,
  parseDemoKeyArgs,
} from "../../../scripts/lib/demo-key.ts";
import { testApp } from "../../helpers/app.js";

const ADMIN_TOKEN = "admin-token-for-demo-key-tests";

describe("parseDemoKeyArgs (spec 013, AC-6)", () => {
  it("applies strict defaults", () => {
    expect(parseDemoKeyArgs([])).toEqual(DEMO_KEY_DEFAULTS);
  });

  it("reads every flag", () => {
    expect(
      parseDemoKeyArgs([
        "--team",
        "t",
        "--name",
        "k",
        "--alias",
        "a",
        "--rpm",
        "3",
        "--tpm",
        "500",
        "--budget-usd",
        "0.25",
        "--rotate",
      ]),
    ).toEqual({
      team: "t",
      name: "k",
      alias: "a",
      rpm: 3,
      tpm: 500,
      budgetUsd: "0.25",
      rotate: true,
    });
  });

  it.each([
    [["--rpm", "0"], /--rpm must be a positive integer/],
    [["--tpm", "1.5"], /--tpm must be a positive integer/],
    [["--budget-usd", "0"], /--budget-usd/],
    [["--budget-usd", "1.23456"], /--budget-usd/],
    [["--budget-usd", "-1"], /--budget-usd/],
    [["--team", " "], /--team must not be empty/],
    [["--unknown"], /Unknown option/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseDemoKeyArgs(argv)).toThrow(message);
  });
});

describe("ensureDemoKey against the admin API (spec 013, AC-6)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function adminApi(): Promise<{ api: AdminApi; calls: string[] }> {
    const built = await testApp({ adminToken: ADMIN_TOKEN, authenticated: false });
    app = built.app;
    const calls: string[] = [];
    const api: AdminApi = {
      baseUrl: "http://gateway.test/",
      adminToken: ADMIN_TOKEN,
      fetch: async (url, init) => {
        const path = url.replace("http://gateway.test", "");
        calls.push(`${init.method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`);
        const res = await built.app.inject({
          method: init.method as "GET",
          url: path,
          headers: init.headers,
          ...(init.body === undefined ? {} : { payload: init.body }),
        });
        return { status: res.statusCode, text: async () => res.body };
      },
    };
    return { api, calls };
  }

  const listKeys = async (teamId: string) => {
    const res = await app?.inject({
      method: "GET",
      url: `/admin/keys?teamId=${teamId}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    return (
      JSON.parse(res?.body ?? "{}") as {
        data: {
          id: string;
          status: string;
          allowedModels: string[] | null;
          rpm: number | null;
          tpm: number | null;
          monthlyBudgetUsd: string | null;
        }[];
      }
    ).data;
  };

  const options = (overrides: Partial<DemoKeyOptions> = {}): DemoKeyOptions => ({
    ...DEMO_KEY_DEFAULTS,
    ...overrides,
  });

  it("creates the team and a key limited to the demo alias with a hard budget", async () => {
    const { api } = await adminApi();
    const result = await ensureDemoKey(
      options({ rpm: 5, tpm: 1000, budgetUsd: "0.5", alias: "demo" }),
      api,
    );
    expect(result.action).toBe("created");
    expect(result.key).toMatch(/^sk-sy-/);
    expect(result.warnings).toEqual([]);
    const [key] = await listKeys(result.teamId);
    expect(key).toMatchObject({
      id: result.keyId,
      status: "active",
      allowedModels: ["demo"],
      rpm: 5,
      tpm: 1000,
      monthlyBudgetUsd: "0.5",
    });
  });

  it("is idempotent: a second run reuses the key, updates its limits and prints no key", async () => {
    const { api, calls } = await adminApi();
    const first = await ensureDemoKey(options(), api);
    calls.length = 0;
    const second = await ensureDemoKey(options({ rpm: 2, budgetUsd: "0.1" }), api);
    expect(second).toMatchObject({ action: "updated", keyId: first.keyId, teamId: first.teamId });
    expect(second.key).toBeUndefined();
    expect(calls).toEqual([
      "GET /admin/teams",
      "PATCH /admin/teams/:id",
      "GET /admin/keys?teamId=:id",
      "PATCH /admin/keys/:id",
    ]);
    const keys = await listKeys(first.teamId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ rpm: 2, monthlyBudgetUsd: "0.1" });
  });

  it("--rotate revokes the old key and prints a new one", async () => {
    const { api } = await adminApi();
    const first = await ensureDemoKey(options(), api);
    const rotated = await ensureDemoKey(options({ rotate: true }), api);
    expect(rotated.action).toBe("rotated");
    expect(rotated.key).toMatch(/^sk-sy-/);
    expect(rotated.key).not.toBe(first.key);
    const keys = await listKeys(first.teamId);
    expect(keys.find((k) => k.id === first.keyId)?.status).toBe("revoked");
    expect(keys.find((k) => k.id === rotated.keyId)?.status).toBe("active");
  });

  it("warns when the existing key allows other models", async () => {
    const { api } = await adminApi();
    await ensureDemoKey(options({ alias: "other" }), api);
    const result = await ensureDemoKey(options({ alias: "demo" }), api);
    expect(result.warnings.join()).toContain("--rotate");
  });

  it("fails with the status and body when the admin token is wrong", async () => {
    const { api } = await adminApi();
    await expect(ensureDemoKey(options(), { ...api, adminToken: "wrong" })).rejects.toThrow(
      /GET \/admin\/teams failed with 401/,
    );
  });
});
