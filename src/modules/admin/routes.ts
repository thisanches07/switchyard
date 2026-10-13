import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConfigError } from "../../config/errors.js";
import type { ApiKeyRecord, AuthRecord, KeyStore } from "../../core/auth.js";
import type { BudgetCounters, BudgetRef, BudgetStore } from "../../core/budget.js";
import { invalidAdminToken, notFound, usageUnavailable } from "../../core/errors.js";
import { PII_MODES } from "../../core/pii.js";
import type { UsageReader } from "../../core/usage.js";
import type { AuthCache } from "../auth/cache.js";
import { displayPrefix, generateKey, hashKey, parseBearer } from "../auth/keys.js";
import { budgetStatus } from "../budgets/status.js";
import type { ReloadResult } from "../config/runtime.js";
import { docs } from "../docs.js";
import { normalize, tryDecimal } from "../pricing/decimal.js";
import type { CandidateHealthView } from "../routing/health.js";
import { normalizeDecimal, parseUsageQuery, todayUtc } from "../usage/report.js";
import { parseWith } from "../validation.js";

export interface AdminRoutesOptions {
  store: KeyStore;
  pepper: string;
  adminToken: string;
  cache: AuthCache<AuthRecord>;
  /** Usage tables (spec 006); GET /admin/usage answers 503 without it. */
  usage?: UsageReader | undefined;
  /** Budget status routes (spec 007); they answer 503 without a store. */
  budgets?: { counters: BudgetCounters; store?: BudgetStore | undefined; now: () => number };
  /** Candidate health and config reload of this instance (spec 008). */
  routing?:
    | {
        health(): CandidateHealthView[];
        /** Throws `ConfigError` when the file is invalid (previous config kept). */
        reload(): ReloadResult;
      }
    | undefined;
}

/** A per-minute limit: positive integer, or null to clear it (spec 005). */
const limit = z.number().int().positive().nullable();

/** At most 8 integer digits and 4 decimal places: what `numeric(12,4)` holds (spec 007). */
const BUDGET = /^\d{1,8}(\.\d{1,4})?$/;
const BUDGET_MESSAGE =
  "must be a number or decimal string from 0 to 99999999.9999 with at most 4 decimal places, or null";

/** A monthly budget in USD (spec 007, AC-4): normalized decimal string, or null to clear. */
const budgetUsd = z
  .union([z.number(), z.string().regex(/^\d+(\.\d+)?$/, BUDGET_MESSAGE)], {
    error: BUDGET_MESSAGE,
  })
  .transform((value, ctx) => {
    const parsed = tryDecimal(value);
    const text = parsed && normalize(parsed);
    if (!text || !BUDGET.test(text)) {
      ctx.addIssue({ code: "custom", message: BUDGET_MESSAGE });
      return z.NEVER;
    }
    return text;
  })
  .nullable();

/** Soft limit, percent of the budget (spec 007). */
const softLimitPct = z.int({ error: "must be an integer from 1 to 100" }).min(1).max(100);

const teamBody = z.object({
  name: z.string().trim().min(1).max(100),
  rpm: limit.optional(),
  tpm: limit.optional(),
  monthlyBudgetUsd: budgetUsd.optional(),
  softLimitPct: softLimitPct.optional(),
});

const teamPatch = z
  .object({
    rpm: limit.optional(),
    tpm: limit.optional(),
    monthlyBudgetUsd: budgetUsd.optional(),
    softLimitPct: softLimitPct.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "set rpm, tpm, monthlyBudgetUsd and/or softLimitPct (null clears a limit or budget)",
    path: ["rpm"],
  });

/** A key's PII mode (spec 010); null falls back to `pii.defaultMode`. */
const piiMode = z.enum(PII_MODES).nullable();

const keyPatch = z
  .object({
    rpm: limit.optional(),
    tpm: limit.optional(),
    piiMode: piiMode.optional(),
    monthlyBudgetUsd: budgetUsd.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "set rpm, tpm, piiMode and/or monthlyBudgetUsd (null clears)",
    path: ["piiMode"],
  });

const keyBody = z.object({
  teamId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  allowedModels: z.array(z.string().min(1)).max(100).nullable().optional(),
  rpm: limit.optional(),
  tpm: limit.optional(),
  piiMode: piiMode.optional(),
  monthlyBudgetUsd: budgetUsd.optional(),
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
    piiMode: record.piiMode,
    monthlyBudgetUsd: record.monthlyBudgetUsd,
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
    const { name, rpm, tpm, monthlyBudgetUsd, softLimitPct } = parseWith(teamBody, request.body);
    const team = await opts.store.createTeam(name, {
      rpm: rpm ?? null,
      tpm: tpm ?? null,
      monthlyBudgetUsd: monthlyBudgetUsd ?? null,
      ...(softLimitPct === undefined ? {} : { softLimitPct }),
    });
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
      piiMode: body.piiMode ?? null,
      monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
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
    const patch = parseWith(keyPatch, request.body);
    const record = await opts.store.updateKeyLimits(id, patch);
    if (!record) throw notFound("API key", id);
    opts.cache.invalidate((cached) => cached.key.id === id);
    request.log.info({ keyId: id, ...patch }, "api key settings updated");
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

  /** Spend and limits of a key or team this period (spec 007, AC-12). */
  const statusOf = (ref: BudgetRef, limitUsd: string | null, softLimitPct: number) => {
    const budgets = opts.budgets;
    if (!budgets?.store) throw usageUnavailable();
    return budgetStatus({
      ref,
      limitUsd,
      softLimitPct,
      counters: budgets.counters,
      store: budgets.store,
      now: budgets.now(),
    });
  };

  app.get("/admin/keys/:id/budget", { schema: docs.keyBudget }, async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const key = await opts.store.getKey(id);
    if (!key) throw notFound("API key", id);
    const team = await opts.store.getTeam(key.teamId);
    // A key's soft limit is its team's percentage (spec 007).
    return statusOf({ scope: "key", id: key.id }, key.monthlyBudgetUsd, team?.softLimitPct ?? 80);
  });

  app.get("/admin/teams/:id/budget", { schema: docs.teamBudget }, async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const team = await opts.store.getTeam(id);
    if (!team) throw notFound("Team", id);
    return statusOf({ scope: "team", id: team.id }, team.monthlyBudgetUsd, team.softLimitPct);
  });
  const routing = opts.routing;
  if (routing) {
    // Breakers and latency are learned per instance (spec 008, AC-11).
    app.get("/admin/providers/health", { schema: docs.providersHealth }, async () => ({
      scope: "instance",
      note: "Breaker and latency state is kept in memory by each gateway instance; other instances may differ",
      data: routing.health(),
    }));

    // Validates and applies the config file now (spec 008, AC-12/AC-13; ADR-0018).
    app.post("/admin/config/reload", { schema: docs.configReload }, async (request, reply) => {
      try {
        const result = routing.reload();
        request.log.info({ result: result.result }, "config reload requested");
        return result;
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        return reply.code(400).send({
          error: {
            message: `Invalid configuration in ${error.source}; the previous configuration is still in use`,
            type: "invalid_request_error",
            code: "invalid_config",
            issues: error.issues,
          },
        });
      }
    });
  }

  app.patch("/admin/teams/:id", { schema: docs.patchTeamLimits }, async (request) => {
    const { id } = parseWith(keyParams, request.params);
    const patch = parseWith(teamPatch, request.body);
    const team = await opts.store.updateTeamLimits(id, patch);
    if (!team) throw notFound("Team", id);
    opts.cache.invalidate((cached) => cached.team.id === id);
    request.log.info({ teamId: id, ...patch }, "team settings updated");
    return team;
  });
}
