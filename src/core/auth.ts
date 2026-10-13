/** A tenant: keys, limits and budgets belong to a team (spec 004). */
export interface Team {
  id: string;
  name: string;
  createdAt: Date;
}

export type KeyStatus = "active" | "revoked";

/** A stored virtual API key. Only the hash of the key is ever persisted. */
export interface ApiKeyRecord {
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

export interface NewKey {
  teamId: string;
  name: string;
  hash: string;
  prefix: string;
  allowedModels: string[] | null;
  expiresAt: Date | null;
}

/** Who is calling, attached to authenticated `/v1` requests. */
export interface Principal {
  keyId: string;
  teamId: string;
  allowedModels: string[] | null;
}

/** Persistence port for teams and keys. Duplicate team names throw a 409 `GatewayError`. */
export interface KeyStore {
  findKeyByHash(hash: string): Promise<ApiKeyRecord | undefined>;
  createTeam(name: string): Promise<Team>;
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  createKey(input: NewKey): Promise<ApiKeyRecord>;
  listKeys(teamId?: string): Promise<ApiKeyRecord[]>;
  /** Idempotent; undefined when the id does not exist. */
  revokeKey(id: string): Promise<ApiKeyRecord | undefined>;
}
