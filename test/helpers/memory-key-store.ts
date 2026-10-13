import { randomUUID } from "node:crypto";
import type {
  ApiKeyRecord,
  AuthRecord,
  KeyStore,
  Limits,
  LimitsPatch,
  NewKey,
  Team,
} from "../../src/core/auth.js";
import { conflict } from "../../src/core/errors.js";
import { displayPrefix, generateKey, hashKey } from "../../src/modules/auth/keys.js";

export const TEST_PEPPER = "test-pepper-0123456789abcdefghijklmnop";
export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

type StoredKey = ApiKeyRecord & { hash: string };

/** In-memory KeyStore with the same semantics as the Drizzle store (tests and contract runs). */
export class MemoryKeyStore implements KeyStore {
  readonly teams = new Map<string, Team>();
  readonly keys = new Map<string, StoredKey>();
  lookups = 0;

  async findKeyByHash(hash: string): Promise<AuthRecord | undefined> {
    this.lookups += 1;
    for (const key of this.keys.values()) {
      const team = this.teams.get(key.teamId);
      if (key.hash === hash && team) return { key: strip(key), team: { ...team } };
    }
    return undefined;
  }

  async createTeam(name: string, limits: Partial<Limits> = {}) {
    if ([...this.teams.values()].some((t) => t.name === name)) {
      throw conflict(`Team "${name}" already exists`);
    }
    const team: Team = {
      id: randomUUID(),
      name,
      rpm: limits.rpm ?? null,
      tpm: limits.tpm ?? null,
      createdAt: new Date(),
    };
    this.teams.set(team.id, team);
    return { ...team };
  }

  async listTeams() {
    return [...this.teams.values()].map((t) => ({ ...t }));
  }

  async getTeam(id: string) {
    const team = this.teams.get(id);
    return team && { ...team };
  }

  async createKey(input: NewKey) {
    const record: StoredKey = {
      id: randomUUID(),
      teamId: input.teamId,
      name: input.name,
      prefix: input.prefix,
      allowedModels: input.allowedModels,
      status: "active",
      rpm: input.rpm ?? null,
      tpm: input.tpm ?? null,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      revokedAt: null,
      hash: input.hash,
    };
    this.keys.set(record.id, record);
    return strip(record);
  }

  async listKeys(teamId?: string) {
    return [...this.keys.values()].filter((k) => !teamId || k.teamId === teamId).map(strip);
  }

  async revokeKey(id: string) {
    const key = this.keys.get(id);
    if (!key) return undefined;
    if (key.status === "active") {
      key.status = "revoked";
      key.revokedAt = new Date();
    }
    return strip(key);
  }

  async updateKeyLimits(id: string, patch: LimitsPatch) {
    const key = this.keys.get(id);
    if (!key) return undefined;
    if (patch.rpm !== undefined) key.rpm = patch.rpm;
    if (patch.tpm !== undefined) key.tpm = patch.tpm;
    return strip(key);
  }

  async updateTeamLimits(id: string, patch: LimitsPatch) {
    const team = this.teams.get(id);
    if (!team) return undefined;
    if (patch.rpm !== undefined) team.rpm = patch.rpm;
    if (patch.tpm !== undefined) team.tpm = patch.tpm;
    return { ...team };
  }

  /** Creates a team (if needed) and an active key; returns the plaintext key. */
  async issueKey(
    options: {
      team?: string;
      allowedModels?: string[] | null;
      expiresAt?: Date | null;
      limits?: Partial<Limits>;
      teamLimits?: Partial<Limits>;
    } = {},
  ) {
    const teamName = options.team ?? "test-team";
    const team =
      [...this.teams.values()].find((t) => t.name === teamName) ??
      (await this.createTeam(teamName, options.teamLimits));
    const key = generateKey();
    const record = await this.createKey({
      teamId: team.id,
      name: "test-key",
      hash: hashKey(TEST_PEPPER, key),
      prefix: displayPrefix(key),
      allowedModels: options.allowedModels ?? null,
      expiresAt: options.expiresAt ?? null,
      rpm: options.limits?.rpm ?? null,
      tpm: options.limits?.tpm ?? null,
    });
    return { key, record, team };
  }
}

function strip(key: StoredKey): ApiKeyRecord {
  const { hash: _hash, ...record } = key;
  return { ...record };
}
