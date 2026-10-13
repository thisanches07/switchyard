import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiKeyRecord, KeyStore } from "../../core/auth.js";
import { invalidAdminToken, notFound } from "../../core/errors.js";
import type { AuthCache } from "../auth/cache.js";
import { displayPrefix, generateKey, hashKey, parseBearer } from "../auth/keys.js";
import { parseWith } from "../validation.js";

export interface AdminRoutesOptions {
  store: KeyStore;
  pepper: string;
  adminToken: string;
  cache: AuthCache<ApiKeyRecord>;
}

const teamBody = z.object({ name: z.string().trim().min(1).max(100) });

const keyBody = z.object({
  teamId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  allowedModels: z.array(z.string().min(1)).max(100).nullable().optional(),
  expiresAt: z.iso
    .datetime({ offset: true })
    .refine((value) => Date.parse(value) > Date.now(), "must be in the future")
    .optional(),
});

const keysQuery = z.object({ teamId: z.uuid().optional() });
const keyParams = z.object({ id: z.string().min(1) });

const digest = (value: string) => createHash("sha256").update(value).digest();

/** What listings return: never the hash, never the key (spec 004, AC-7). */
function keyView(record: ApiKeyRecord) {
  return {
    id: record.id,
    teamId: record.teamId,
    name: record.name,
    prefix: record.prefix,
    allowedModels: record.allowedModels,
    status: record.status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

/** Admin API for teams and keys, behind `Authorization: Bearer <ADMIN_TOKEN>` (spec 004). */
export async function adminRoutes(app: FastifyInstance, opts: AdminRoutesOptions): Promise<void> {
  const expected = digest(opts.adminToken);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = parseBearer(request.headers.authorization);
    // Hashing both sides gives equal lengths, so the comparison is constant time.
    if (!token || !timingSafeEqual(digest(token), expected)) throw invalidAdminToken();
  });

  app.post("/admin/teams", async (request, reply) => {
    const { name } = parseWith(teamBody, request.body);
    const team = await opts.store.createTeam(name);
    return reply.code(201).send(team);
  });

  app.get("/admin/teams", async () => ({ data: await opts.store.listTeams() }));

  app.post("/admin/keys", async (request, reply) => {
    const body = parseWith(keyBody, request.body);
    const team = await opts.store.getTeam(body.teamId);
    if (!team) throw notFound("Team", body.teamId);

    const key = generateKey();
    const record = await opts.store.createKey({
      teamId: team.id,
      name: body.name,
      hash: hashKey(opts.pepper, key),
      prefix: displayPrefix(key),
      allowedModels: body.allowedModels ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    request.log.info({ keyId: record.id, teamId: team.id }, "api key created");
    // The only time the plaintext key leaves the gateway.
    return reply.code(201).send({ ...keyView(record), key });
  });

  app.get("/admin/keys", async (request) => {
    const { teamId } = parseWith(keysQuery, request.query);
    return { data: (await opts.store.listKeys(teamId)).map(keyView) };
  });

  app.post("/admin/keys/:id/revoke", async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const record = await opts.store.revokeKey(id);
    if (!record) throw notFound("API key", id);
    opts.cache.invalidateKey(id);
    request.log.info({ keyId: id }, "api key revoked");
    return keyView(record);
  });
}
