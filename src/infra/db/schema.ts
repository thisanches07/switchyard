import { char, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const keyStatus = pgEnum("api_key_status", ["active", "revoked"]);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_team_id_idx").on(table.teamId)],
);
