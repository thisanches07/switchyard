import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

/** `drizzle/` at the repository (or image) root, from both `src/` and `dist/`. */
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../../../drizzle");

/** Applies pending SQL migrations; already-applied ones are skipped (spec 004, AC-1). */
export async function migrateDatabase(db: Database, folder = MIGRATIONS_FOLDER): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
