import { and, eq } from "drizzle-orm";
import type {
  ApiKeyRecord,
  AuthRecord,
  KeyPatch,
  KeyStore,
  Limits,
  LimitsPatch,
  NewKey,
  Team,
} from "../../core/auth.js";
import { conflict } from "../../core/errors.js";
import type { Database } from "./client.js";
import { apiKeys, teams } from "./schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type KeyRow = typeof apiKeys.$inferSelect;
type TeamRow = typeof teams.$inferSelect;

/** `KeyStore` backed by Postgres through Drizzle (ADR-0005). */
export class DrizzleKeyStore implements KeyStore {
  constructor(private readonly db: Database) {}

  async findKeyByHash(hash: string): Promise<AuthRecord | undefined> {
    const [row] = await this.db
      .select({ key: apiKeys, team: teams })
      .from(apiKeys)
      .innerJoin(teams, eq(apiKeys.teamId, teams.id))
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);
    return row && { key: toRecord(row.key), team: toTeam(row.team) };
  }

  async createTeam(name: string, limits: Partial<Limits> = {}): Promise<Team> {
    try {
      const [row] = await this.db
        .insert(teams)
        .values({ name, rpm: limits.rpm ?? null, tpm: limits.tpm ?? null })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return toTeam(row);
    } catch (error) {
      if (pgCode(error) === "23505") throw conflict(`Team "${name}" already exists`);
      throw error;
    }
  }

  async listTeams(): Promise<Team[]> {
    const rows = await this.db.select().from(teams).orderBy(teams.createdAt);
    return rows.map(toTeam);
  }

  async getTeam(id: string): Promise<Team | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(teams).where(eq(teams.id, id)).limit(1);
    return row && toTeam(row);
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
        rpm: input.rpm ?? null,
        tpm: input.tpm ?? null,
        piiMode: input.piiMode ?? null,
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

  async updateKeyLimits(id: string, patch: KeyPatch): Promise<ApiKeyRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    const values: Partial<typeof apiKeys.$inferInsert> = limitValues(patch);
    if (patch.piiMode !== undefined) values.piiMode = patch.piiMode;
    if (Object.keys(values).length === 0) {
      const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
      return row && toRecord(row);
    }
    const [row] = await this.db.update(apiKeys).set(values).where(eq(apiKeys.id, id)).returning();
    return row && toRecord(row);
  }

  async updateTeamLimits(id: string, patch: LimitsPatch): Promise<Team | undefined> {
    if (!UUID.test(id)) return undefined;
    const values = limitValues(patch);
    if (Object.keys(values).length === 0) return this.getTeam(id);
    const [row] = await this.db.update(teams).set(values).where(eq(teams.id, id)).returning();
    return row && toTeam(row);
  }
}

/** Only the fields present in the patch; `null` clears a limit. */
function limitValues(patch: LimitsPatch): Partial<Limits> {
  const values: Partial<Limits> = {};
  if (patch.rpm !== undefined) values.rpm = patch.rpm;
  if (patch.tpm !== undefined) values.tpm = patch.tpm;
  return values;
}

function toTeam(row: TeamRow): Team {
  return { id: row.id, name: row.name, rpm: row.rpm, tpm: row.tpm, createdAt: row.createdAt };
}

function toRecord(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    prefix: row.keyPrefix,
    allowedModels: row.allowedModels,
    status: row.status,
    rpm: row.rpm,
    tpm: row.tpm,
    piiMode: row.piiMode,
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
