/** Per-minute limits (spec 005). null = not set at this level. */
export interface Limits {
  rpm: number | null;
  tpm: number | null;
}

/** Limits to change: omitted (or undefined) fields stay as they are; null clears. */
export type LimitsPatch = { [K in keyof Limits]?: Limits[K] | undefined };

/** A tenant: keys, limits and budgets belong to a team (spec 004). */
export interface Team extends Limits {
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
}

/** Who is calling, attached to authenticated `/v1` requests. */
export interface Principal {
  keyId: string;
  teamId: string;
  allowedModels: string[] | null;
  keyLimits: Limits;
  teamLimits: Limits;
}

/** Persistence port for teams and keys. Duplicate team names throw a 409 `GatewayError`. */
export interface KeyStore {
  findKeyByHash(hash: string): Promise<AuthRecord | undefined>;
  createTeam(name: string, limits?: Partial<Limits>): Promise<Team>;
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  createKey(input: NewKey): Promise<ApiKeyRecord>;
  listKeys(teamId?: string): Promise<ApiKeyRecord[]>;
  /** Idempotent; undefined when the id does not exist. */
  revokeKey(id: string): Promise<ApiKeyRecord | undefined>;
  /** Sets or clears (null) limits; omitted fields are unchanged. undefined when not found. */
  updateKeyLimits(id: string, patch: LimitsPatch): Promise<ApiKeyRecord | undefined>;
  updateTeamLimits(id: string, patch: LimitsPatch): Promise<Team | undefined>;
}
