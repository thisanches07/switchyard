import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiKeyRecord, AuthRecord, KeyStore } from "../../core/auth.js";
import { invalidAdminToken, notFound, usageUnavailable } from "../../core/errors.js";
import type { UsageReader } from "../../core/usage.js";
import type { AuthCache } from "../auth/cache.js";
import { displayPrefix, generateKey, hashKey, parseBearer } from "../auth/keys.js";
import { docs } from "../docs.js";
import { normalizeDecimal, parseUsageQuery, todayUtc } from "../usage/report.js";
import { parseWith } from "../validation.js";

export interface AdminRoutesOptions {
  store: KeyStore;
  pepper: string;
  adminToken: string;
  cache: AuthCache<AuthRecord>;
  /** Usage tables (spec 006); GET /admin/usage answers 503 without it. */
  usage?: UsageReader | undefined;
}

/** A per-minute limit: positive integer, or null to clear it (spec 005). */
const limit = z.number().int().positive().nullable();

const teamBody = z.object({
  name: z.string().trim().min(1).max(100),
  rpm: limit.optional(),
  tpm: limit.optional(),
});

const limitsPatch = z
  .object({ rpm: limit.optional(), tpm: limit.optional() })
  .refine((patch) => patch.rpm !== undefined || patch.tpm !== undefined, {
    message: "set rpm and/or tpm (a positive integer, or null to clear)",
    path: ["rpm"],
  });

const keyBody = z.object({
  teamId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  allowedModels: z.array(z.string().min(1)).max(100).nullable().optional(),
  rpm: limit.optional(),
  tpm: limit.optional(),
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
    rpm: record.rpm,
    tpm: record.tpm,
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

  app.post("/admin/teams", { schema: docs.createTeam }, async (request, reply) => {
    const { name, rpm, tpm } = parseWith(teamBody, request.body);
    const team = await opts.store.createTeam(name, { rpm: rpm ?? null, tpm: tpm ?? null });
    return reply.code(201).send(team);
  });

  app.get("/admin/teams", { schema: docs.listTeams }, async () => ({
    data: await opts.store.listTeams(),
  }));

  app.post("/admin/keys", { schema: docs.createKey }, async (request, reply) => {
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
      rpm: body.rpm ?? null,
      tpm: body.tpm ?? null,
    });
    request.log.info({ keyId: record.id, teamId: team.id }, "api key created");
    // The only time the plaintext key leaves the gateway.
    return reply.code(201).send({ ...keyView(record), key });
  });

  app.get("/admin/keys", { schema: docs.listKeys }, async (request) => {
    const { teamId } = parseWith(keysQuery, request.query);
    return { data: (await opts.store.listKeys(teamId)).map(keyView) };
  });

  app.post("/admin/keys/:id/revoke", { schema: docs.revokeKey }, async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const record = await opts.store.revokeKey(id);
    if (!record) throw notFound("API key", id);
    opts.cache.invalidate((cached) => cached.key.id === id);
    request.log.info({ keyId: id }, "api key revoked");
    return keyView(record);
  });

  app.patch("/admin/keys/:id", { schema: docs.patchKeyLimits }, async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const patch = parseWith(limitsPatch, request.body);
    const record = await opts.store.updateKeyLimits(id, patch);
    if (!record) throw notFound("API key", id);
    opts.cache.invalidate((cached) => cached.key.id === id);
    request.log.info({ keyId: id, ...patch }, "api key limits updated");
    return keyView(record);
  });

  // Usage per team, key, model, provider or day (spec 006, AC-11). Eventually consistent.
  app.get("/admin/usage", { schema: docs.usage }, async (request) => {
    if (!opts.usage) throw usageUnavailable();
    const query = parseUsageQuery(request.query, todayUtc());
    const report = await opts.usage.summarize(query);
    return {
      from: query.from,
      to: query.to,
      groupBy: query.groupBy,
      data: report.data.map((row) => ({ ...row, costUsd: normalizeDecimal(row.costUsd) })),
      totals: { ...report.totals, costUsd: normalizeDecimal(report.totals.costUsd) },
    };
  });

  app.patch("/admin/teams/:id", { schema: docs.patchTeamLimits }, async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const patch = parseWith(limitsPatch, request.body);
    const team = await opts.store.updateTeamLimits(id, patch);
    if (!team) throw notFound("Team", id);
    opts.cache.invalidate((cached) => cached.team.id === id);
    request.log.info({ teamId: id, ...patch }, "team limits updated");
    return team;
  });
}
