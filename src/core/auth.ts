import type { PiiMode } from "./pii.js";

/** Per-minute limits (spec 005). null = not set at this level. */
export interface Limits {
  rpm: number | null;
  tpm: number | null;
}

/** Limits to change: omitted (or undefined) fields stay as they are; null clears. */
export type LimitsPatch = { [K in keyof Limits]?: Limits[K] | undefined };

/** Key settings to change: limits, PII mode (spec 010) and budget (spec 007). Omitted fields stay; null clears. */
export type KeyPatch = LimitsPatch & {
  piiMode?: PiiMode | null | undefined;
  monthlyBudgetUsd?: string | null | undefined;
};

/** Monthly budget settings of a team (spec 007). */
export interface TeamBudget {
  /** USD decimal string; null = no budget. */
  monthlyBudgetUsd: string | null;
  /** Soft limit, percent of the budget (1–100). Also applies to the team's keys. */
  softLimitPct: number;
}

/** Team settings to change: limits and budget (spec 007). Omitted fields stay; null clears. */
export type TeamPatch = LimitsPatch & {
  monthlyBudgetUsd?: string | null | undefined;
  softLimitPct?: number | undefined;
};

/** Settings of a new team; omitted ones use the defaults (no limits, no budget, 80 %). */
export type TeamSettings = Partial<Limits> & Partial<TeamBudget>;

/** A tenant: keys, limits and budgets belong to a team (spec 004). */
export interface Team extends Limits, TeamBudget {
  id: string;
  name: string;
  createdAt: Date;
}

export type KeyStatus = "active" | "revoked";

/** A stored virtual API key. Only the hash of the key is ever persisted. */
export interface ApiKeyRecord extends Limits {
  id: string;
  teamId: string;
  name: string;
  prefix: string;
  /** null or empty: every model is allowed. */
  allowedModels: string[] | null;
  status: KeyStatus;
  /** PII redaction mode (spec 010); null = `pii.defaultMode` from the config. */
  piiMode: PiiMode | null;
  /** Monthly budget in USD (spec 007), decimal string; null = no budget. */
  monthlyBudgetUsd: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What authentication needs: the key and its team (for team limits). */
export interface AuthRecord {
  key: ApiKeyRecord;
  team: Team;
}

export interface NewKey {
  teamId: string;
  name: string;
  hash: string;
  prefix: string;
  allowedModels: string[] | null;
  expiresAt: Date | null;
  rpm?: number | null;
  tpm?: number | null;
  piiMode?: PiiMode | null;
  monthlyBudgetUsd?: string | null;
}

/** Who is calling, attached to authenticated `/v1` requests. */
export interface Principal {
  keyId: string;
  teamId: string;
  allowedModels: string[] | null;
  keyLimits: Limits;
  teamLimits: Limits;
  /** The key's own PII mode (spec 010); null or absent = the config default. */
  piiMode?: PiiMode | null;
  /** Monthly budgets of the key and its team (spec 007); absent = none. */
  budget?: PrincipalBudget;
}

/** Budgets that apply to a request (spec 007): USD decimal strings, null = no budget. */
export interface PrincipalBudget {
  keyUsd: string | null;
  teamUsd: string | null;
  /** The team's soft limit percentage; a key's budget uses it too. */
  softLimitPct: number;
}

/** Persistence port for teams and keys. Duplicate team names throw a 409 `GatewayError`. */
export interface KeyStore {
  findKeyByHash(hash: string): Promise<AuthRecord | undefined>;
  createTeam(name: string, settings?: TeamSettings): Promise<Team>;
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  createKey(input: NewKey): Promise<ApiKeyRecord>;
  /** undefined when the id does not exist. */
  getKey(id: string): Promise<ApiKeyRecord | undefined>;
  listKeys(teamId?: string): Promise<ApiKeyRecord[]>;
  /** Idempotent; undefined when the id does not exist. */
  revokeKey(id: string): Promise<ApiKeyRecord | undefined>;
  /** Sets or clears (null) limits and PII mode; omitted fields unchanged. undefined if not found. */
  updateKeyLimits(id: string, patch: KeyPatch): Promise<ApiKeyRecord | undefined>;
  updateTeamLimits(id: string, patch: TeamPatch): Promise<Team | undefined>;
}
