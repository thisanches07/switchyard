import type { ConfigIssue } from "./errors.js";

/**
 * Dev defaults a production deployment must not run with (spec 013, AC-4). `docker-compose.yml`
 * ships `dev-only-*` values for ADMIN_TOKEN and KEY_PEPPER and the database password
 * `switchyard`; the production Compose file sets SWITCHYARD_REQUIRE_SECRETS=true so the gateway
 * refuses to start with any of them. Messages never echo the values.
 */
export function findDevSecrets(env: {
  ADMIN_TOKEN?: string | undefined;
  KEY_PEPPER: string;
  DATABASE_URL: string;
}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!env.ADMIN_TOKEN) {
    issues.push({
      path: "ADMIN_TOKEN",
      message: "is required when SWITCHYARD_REQUIRE_SECRETS=true",
    });
  } else if (env.ADMIN_TOKEN.startsWith("dev-only")) {
    issues.push({ path: "ADMIN_TOKEN", message: "is a dev-only default; set a random value" });
  }
  if (env.KEY_PEPPER.startsWith("dev-only")) {
    issues.push({ path: "KEY_PEPPER", message: "is a dev-only default; set a random value" });
  }
  if (databasePassword(env.DATABASE_URL) === "switchyard") {
    issues.push({
      path: "DATABASE_URL",
      message: "uses the dev database password from docker-compose.yml",
    });
  }
  return issues;
}

function databasePassword(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return undefined;
  }
}
