/**
 * `pnpm demo:key` (spec 013, AC-6): creates or updates the public demo team and key through the
 * admin API. The key gets a hard monthly budget (spec 007), strict rpm/tpm limits (spec 005) and
 * may only use the demo alias (spec 004). Idempotent: an existing active key with the same name
 * in the team is kept and its limits are updated; a key's plaintext is printed only when it is
 * created (first run or --rotate).
 */
import { parseArgs } from "node:util";
import { z } from "zod";

export interface DemoKeyOptions {
  team: string;
  name: string;
  alias: string;
  rpm: number;
  tpm: number;
  budgetUsd: string;
  rotate: boolean;
}

export const DEMO_KEY_DEFAULTS: DemoKeyOptions = {
  team: "demo",
  name: "demo",
  alias: "demo",
  rpm: 10,
  tpm: 20_000,
  budgetUsd: "1",
  rotate: false,
};

export const DEMO_KEY_USAGE = `Usage: pnpm demo:key [--team demo] [--name demo] [--alias demo]
                     [--rpm 10] [--tpm 20000] [--budget-usd 1] [--rotate]
Env: SWITCHYARD_ADMIN_URL (default http://localhost:8080, e.g. through an SSH tunnel), ADMIN_TOKEN`;

const positiveInt = (flag: string, value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${flag} must be a positive integer`);
  return Number(value);
};

/** Parses CLI flags; throws with a readable message on invalid input. */
export function parseDemoKeyArgs(argv: readonly string[]): DemoKeyOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      team: { type: "string" },
      name: { type: "string" },
      alias: { type: "string" },
      rpm: { type: "string" },
      tpm: { type: "string" },
      "budget-usd": { type: "string" },
      rotate: { type: "boolean" },
    },
    strict: true,
  });
  const budgetUsd = values["budget-usd"] ?? DEMO_KEY_DEFAULTS.budgetUsd;
  if (!/^\d+(\.\d{1,4})?$/.test(budgetUsd) || Number(budgetUsd) <= 0) {
    throw new Error("--budget-usd must be a positive decimal with at most 4 decimal places");
  }
  for (const flag of ["team", "name", "alias"] as const) {
    const value = values[flag];
    if (value !== undefined && value.trim() === "") throw new Error(`--${flag} must not be empty`);
  }
  return {
    team: values.team ?? DEMO_KEY_DEFAULTS.team,
    name: values.name ?? DEMO_KEY_DEFAULTS.name,
    alias: values.alias ?? DEMO_KEY_DEFAULTS.alias,
    rpm: positiveInt("rpm", values.rpm, DEMO_KEY_DEFAULTS.rpm),
    tpm: positiveInt("tpm", values.tpm, DEMO_KEY_DEFAULTS.tpm),
    budgetUsd,
    rotate: values.rotate ?? false,
  };
}

/** The subset of `fetch` the script needs, so tests can pass a fake admin API. */
export type AdminFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface AdminApi {
  baseUrl: string;
  adminToken: string;
  fetch: AdminFetch;
}

const team = z.object({ id: z.string(), name: z.string() });
const key = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  status: z.string(),
  allowedModels: z.array(z.string()).nullable(),
});
const teamList = z.object({ data: z.array(team) });
const keyList = z.object({ data: z.array(key) });
const createdKey = key.extend({ key: z.string() });

async function call<T>(
  api: AdminApi,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const res = await api.fetch(`${api.baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`);
  }
  return schema.parse(JSON.parse(text));
}

export interface DemoKeyResult {
  action: "created" | "rotated" | "updated";
  teamId: string;
  keyId: string;
  prefix: string;
  /** Plaintext key, only when one was created. */
  key?: string;
  warnings: string[];
}

export async function ensureDemoKey(
  options: DemoKeyOptions,
  api: AdminApi,
): Promise<DemoKeyResult> {
  const limits = { rpm: options.rpm, tpm: options.tpm, monthlyBudgetUsd: options.budgetUsd };
  const warnings: string[] = [];

  const teams = await call(api, "GET", "/admin/teams", teamList);
  let teamId = teams.data.find((t) => t.name === options.team)?.id;
  if (teamId) {
    await call(api, "PATCH", `/admin/teams/${teamId}`, team, limits);
  } else {
    teamId = (await call(api, "POST", "/admin/teams", team, { name: options.team, ...limits })).id;
  }

  const keys = await call(api, "GET", `/admin/keys?teamId=${encodeURIComponent(teamId)}`, keyList);
  const active = keys.data.filter((k) => k.name === options.name && k.status === "active");
  const [current] = active;

  if (current && !options.rotate) {
    const updated = await call(api, "PATCH", `/admin/keys/${current.id}`, key, limits);
    const allowed = updated.allowedModels ?? [];
    if (allowed.length !== 1 || allowed[0] !== options.alias) {
      warnings.push(
        `key ${updated.prefix} allows ${JSON.stringify(updated.allowedModels)}, not ["${options.alias}"]; run with --rotate to replace it`,
      );
    }
    if (active.length > 1) warnings.push(`${active.length} active keys named "${options.name}"`);
    return { action: "updated", teamId, keyId: updated.id, prefix: updated.prefix, warnings };
  }

  for (const old of active) {
    await call(api, "POST", `/admin/keys/${old.id}/revoke`, key);
  }
  const created = await call(api, "POST", "/admin/keys", createdKey, {
    teamId,
    name: options.name,
    allowedModels: [options.alias],
    ...limits,
  });
  return {
    action: active.length > 0 ? "rotated" : "created",
    teamId,
    keyId: created.id,
    prefix: created.prefix,
    key: created.key,
    warnings,
  };
}
