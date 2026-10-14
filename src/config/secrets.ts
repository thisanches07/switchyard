import type { ConfigIssue } from "./errors.js";

/** `dev-only-*` ships in docker-compose.yml; `replace-me-*` in deploy/compose/switchyard.env.example. */
const isPlaceholder = (value: string) => /^(dev-only|replace-me)/.test(value);

/**
 * Dev defaults a production deployment must not run with (spec 013, AC-4). `docker-compose.yml`
 * ships `dev-only-*` values for ADMIN_TOKEN and KEY_PEPPER and the database password
 * `switchyard`; the production env example ships `replace-me-*` placeholders. The production
 * Compose file sets SWITCHYARD_REQUIRE_SECRETS=true so the gateway refuses to start with any of
 * them. Messages never echo the values.
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
  } else if (isPlaceholder(env.ADMIN_TOKEN)) {
    issues.push({ path: "ADMIN_TOKEN", message: "is a dev-only default; set a random value" });
  }
  if (isPlaceholder(env.KEY_PEPPER)) {
    issues.push({ path: "KEY_PEPPER", message: "is a dev-only default; set a random value" });
  }
  const password = databasePassword(env.DATABASE_URL);
  if (password === "switchyard" || (password !== undefined && isPlaceholder(password))) {
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
