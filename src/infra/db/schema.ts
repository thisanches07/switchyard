import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const keyStatus = pgEnum("api_key_status", ["active", "revoked"]);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    /** Per-minute caps across all keys of the team; NULL = no team cap (spec 005). */
    rpm: integer("rpm"),
    tpm: integer("tpm"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("teams_rpm_positive", sql`${table.rpm} > 0`),
    check("teams_tpm_positive", sql`${table.tpm} > 0`),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Hex SHA-256(pepper + key); the key itself is never stored (spec 004, AC-2). */
    keyHash: char("key_hash", { length: 64 }).notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    /** NULL or empty: every model is allowed. */
    allowedModels: text("allowed_models").array(),
    status: keyStatus("status").notNull().default("active"),
    /** Per-minute limits; NULL = use limits.defaults from the config (spec 005). */
    rpm: integer("rpm"),
    tpm: integer("tpm"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("api_keys_team_id_idx").on(table.teamId),
    check("api_keys_rpm_positive", sql`${table.rpm} > 0`),
    check("api_keys_tpm_positive", sql`${table.tpm} > 0`),
  ],
);
