// pnpm db:migrate: applies pending migrations to DATABASE_URL (spec 004, AC-1).
import { createDatabase } from "../src/infra/db/client.js";
import { migrateDatabase } from "../src/infra/db/migrate.js";
import { createPostgresPool } from "../src/infra/db/postgres.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = createPostgresPool(url);
try {
  await migrateDatabase(createDatabase(pool));
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
