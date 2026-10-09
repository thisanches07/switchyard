import pg from "pg";
import type { DependencyCheck } from "../../core/health.js";

export function createPostgresPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
}

export function postgresCheck(pool: pg.Pool): DependencyCheck {
  return {
    name: "postgres",
    async check(signal) {
      signal.throwIfAborted();
      await pool.query("SELECT 1");
    },
  };
}
