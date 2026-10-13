import { and, eq } from "drizzle-orm";
import type { ApiKeyRecord, KeyStore, NewKey, Team } from "../../core/auth.js";
import { conflict } from "../../core/errors.js";
import type { Database } from "./client.js";
import { apiKeys, teams } from "./schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type KeyRow = typeof apiKeys.$inferSelect;

/** `KeyStore` backed by Postgres through Drizzle (ADR-0005). */
export class DrizzleKeyStore implements KeyStore {
  constructor(private readonly db: Database) {}

  async findKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    return row && toRecord(row);
  }

  async createTeam(name: string): Promise<Team> {
    try {
      const [row] = await this.db.insert(teams).values({ name }).returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    } catch (error) {
      if (pgCode(error) === "23505") throw conflict(`Team "${name}" already exists`);
      throw error;
    }
  }

  async listTeams(): Promise<Team[]> {
    return this.db.select().from(teams).orderBy(teams.createdAt);
  }

  async getTeam(id: string): Promise<Team | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(teams).where(eq(teams.id, id)).limit(1);
    return row;
  }

  async createKey(input: NewKey): Promise<ApiKeyRecord> {
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        teamId: input.teamId,
        name: input.name,
        keyHash: input.hash,
        keyPrefix: input.prefix,
        allowedModels: input.allowedModels,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toRecord(row);
  }

  async listKeys(teamId?: string): Promise<ApiKeyRecord[]> {
    if (teamId !== undefined && !UUID.test(teamId)) return [];
    const query = this.db.select().from(apiKeys);
    const rows = await (teamId ? query.where(eq(apiKeys.teamId, teamId)) : query).orderBy(
      apiKeys.createdAt,
    );
    return rows.map(toRecord);
  }

  async revokeKey(id: string): Promise<ApiKeyRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    const [revoked] = await this.db
      .update(apiKeys)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.status, "active")))
      .returning();
    if (revoked) return toRecord(revoked);
    // Already revoked (idempotent) or unknown.
    const [existing] = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return existing && toRecord(existing);
  }
}

function toRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    prefix: row.keyPrefix,
    allowedModels: row.allowedModels,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/** Postgres error code, looking through Drizzle's `DrizzleQueryError.cause`. */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}
