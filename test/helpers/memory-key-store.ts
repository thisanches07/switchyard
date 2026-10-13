import { randomUUID } from "node:crypto";
import type { ApiKeyRecord, KeyStore, NewKey, Team } from "../../src/core/auth.js";
import { conflict } from "../../src/core/errors.js";
import { displayPrefix, generateKey, hashKey } from "../../src/modules/auth/keys.js";

export const TEST_PEPPER = "test-pepper-0123456789abcdefghijklmnop";
export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

/** In-memory KeyStore with the same semantics as the Drizzle store (tests and contract runs). */
export class MemoryKeyStore implements KeyStore {
  readonly teams = new Map<string, Team>();
  readonly keys = new Map<string, ApiKeyRecord & { hash: string }>();
  lookups = 0;

  async findKeyByHash(hash: string) {
    this.lookups += 1;
    for (const key of this.keys.values()) {
      if (key.hash === hash) return strip(key);
    }
    return undefined;
  }

  async createTeam(name: string) {
    if ([...this.teams.values()].some((t) => t.name === name)) {
      throw conflict(`Team "${name}" already exists`);
    }
    const team = { id: randomUUID(), name, createdAt: new Date() };
    this.teams.set(team.id, team);
    return team;
  }

  async listTeams() {
    return [...this.teams.values()];
  }

  async getTeam(id: string) {
    return this.teams.get(id);
  }

  async createKey(input: NewKey) {
    const record = {
      id: randomUUID(),
      teamId: input.teamId,
      name: input.name,
      prefix: input.prefix,
      allowedModels: input.allowedModels,
      status: "active" as const,
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
      key.status = "revoked" as never;
      key.revokedAt = new Date() as never;
    }
    return strip(key);
  }

  /** Creates a team (if needed) and an active key; returns the plaintext key. */
  async issueKey(
    options: { team?: string; allowedModels?: string[] | null; expiresAt?: Date | null } = {},
  ) {
    const teamName = options.team ?? "test-team";
    const team =
      [...this.teams.values()].find((t) => t.name === teamName) ??
      (await this.createTeam(teamName));
    const key = generateKey();
    const record = await this.createKey({
      teamId: team.id,
      name: "test-key",
      hash: hashKey(TEST_PEPPER, key),
      prefix: displayPrefix(key),
      allowedModels: options.allowedModels ?? null,
      expiresAt: options.expiresAt ?? null,
    });
    return { key, record, team };
  }
}

function strip(key: ApiKeyRecord & { hash: string }): ApiKeyRecord {
  const { hash: _hash, ...record } = key;
  return { ...record };
}
