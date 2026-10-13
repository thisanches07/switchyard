import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "../../helpers/app.js";
import { TEST_ADMIN_TOKEN } from "../../helpers/memory-key-store.js";

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

describe("admin API", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(adminToken: string | null = TEST_ADMIN_TOKEN) {
    const { app, store } = await testApp({
      authenticated: false,
      ...(adminToken === null ? {} : { adminToken }),
    });
    apps.push(app);
    const call = (method: "GET" | "POST", url: string, payload?: object, headers = admin) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    return { app, store, call };
  }

  async function createTeam(call: Awaited<ReturnType<typeof setup>>["call"], name = "search") {
    const res = await call("POST", "/admin/teams", { name });
    return res.json() as { id: string; name: string };
  }

  describe("authentication", () => {
    it.each([
      ["missing token", {}],
      ["wrong token", { authorization: "Bearer not-the-admin-token" }],
      ["an API key instead of the admin token", { authorization: "Bearer sk-sy-x" }],
    ])("rejects %s with 401", async (_label, headers) => {
      const { call } = await setup();
      const res = await call("GET", "/admin/teams", undefined, headers as typeof admin);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("invalid_admin_token");
    });

    it("is absent (404) when ADMIN_TOKEN is not configured", async () => {
      const { call } = await setup(null);
      expect((await call("GET", "/admin/teams")).statusCode).toBe(404);
    });

    it("never caches admin responses", async () => {
      const { call } = await setup();
      expect((await call("GET", "/admin/teams")).headers["cache-control"]).toBe("no-store");
    });
  });

  describe("teams", () => {
    it("creates and lists teams", async () => {
      const { call } = await setup();
      const res = await call("POST", "/admin/teams", { name: "search" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: expect.any(String), name: "search" });
      const list = (await call("GET", "/admin/teams")).json() as { data: { name: string }[] };
      expect(list.data.map((t) => t.name)).toContain("search");
    });

    it("rejects duplicates with 409 and invalid names with 400", async () => {
      const { call } = await setup();
      await call("POST", "/admin/teams", { name: "search" });
      expect((await call("POST", "/admin/teams", { name: "search" })).statusCode).toBe(409);
      const invalid = await call("POST", "/admin/teams", { name: "" });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.message).toContain("name");
    });
  });

  describe("keys", () => {
    it("returns the plaintext key once and it authenticates /v1", async () => {
      const { app, call } = await setup();
      const team = await createTeam(call);
      const res = await call("POST", "/admin/keys", {
        teamId: team.id,
        name: "web",
        allowedModels: ["fast"],
      });
      expect(res.statusCode).toBe(201);
      const created = res.json() as { id: string; key: string; prefix: string };
      expect(created.key).toMatch(/^sk-sy-[0-9A-Za-z]{43}$/);
      expect(created.prefix).toBe(created.key.slice(0, 10));
      expect(created).toMatchObject({ teamId: team.id, name: "web", allowedModels: ["fast"] });

      const chat = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${created.key}` },
        payload: { model: "fast", messages: [{ role: "user", content: "hi" }] },
      });
      expect(chat.statusCode).toBe(200);

      const listed = await call("GET", `/admin/keys?teamId=${team.id}`);
      expect(listed.body).not.toContain(created.key);
      expect(listed.body).not.toMatch(/"(hash|keyHash|key)"/);
      expect((listed.json() as { data: { id: string; status: string }[] }).data).toEqual([
        expect.objectContaining({ id: created.id, status: "active", prefix: created.prefix }),
      ]);
    });

    it.each([
      [{ name: "web" }, "teamId"],
      [{ teamId: "not-a-uuid", name: "web" }, "teamId"],
      [{ teamId: "00000000-0000-4000-8000-000000000000" }, "name"],
      [
        { teamId: "00000000-0000-4000-8000-000000000000", name: "w", allowedModels: "fast" },
        "allowedModels",
      ],
      [
        {
          teamId: "00000000-0000-4000-8000-000000000000",
          name: "w",
          expiresAt: "2000-01-01T00:00:00Z",
        },
        "expiresAt",
      ],
    ])("rejects invalid key body %j (400 naming %s)", async (payload, field) => {
      const { call } = await setup();
      const res = await call("POST", "/admin/keys", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain(field);
    });

    it("returns 404 for an unknown team", async () => {
      const { call } = await setup();
      const res = await call("POST", "/admin/keys", {
        teamId: "00000000-0000-4000-8000-000000000000",
        name: "web",
      });
      expect(res.statusCode).toBe(404);
    });

    it("revokes keys: rejected immediately, idempotent, 404 for unknown ids", async () => {
      const { app, call } = await setup();
      const team = await createTeam(call);
      const created = (
        await call("POST", "/admin/keys", { teamId: team.id, name: "web" })
      ).json() as {
        id: string;
        key: string;
      };
      const useKey = () =>
        app.inject({
          method: "GET",
          url: "/v1/models",
          headers: { authorization: `Bearer ${created.key}` },
        });
      expect((await useKey()).statusCode).toBe(200); // now cached

      const revoked = await call("POST", `/admin/keys/${created.id}/revoke`);
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ id: created.id, status: "revoked" });
      expect((await useKey()).statusCode).toBe(401);

      expect((await call("POST", `/admin/keys/${created.id}/revoke`)).statusCode).toBe(200);
      expect(
        (await call("POST", "/admin/keys/00000000-0000-4000-8000-000000000000/revoke")).statusCode,
      ).toBe(404);
    });
  });
});
