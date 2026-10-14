// `pnpm demo:key` (spec 013, AC-6): creates or updates the public demo key through the admin API.
// Cross-platform, plain Node 24. On the demo VM the admin API is only reachable through an SSH
// tunnel: `ssh -N -L 8080:172.30.0.10:8080 ubuntu@<host>` (docs/deploy.md).
// stdout carries only the plaintext key (when one is created); everything else goes to stderr.
import { DEMO_KEY_USAGE, ensureDemoKey, parseDemoKeyArgs } from "./lib/demo-key.ts";

const adminToken = process.env.ADMIN_TOKEN;
const baseUrl = process.env.SWITCHYARD_ADMIN_URL ?? "http://localhost:8080";

let options: ReturnType<typeof parseDemoKeyArgs>;
try {
  options = parseDemoKeyArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${DEMO_KEY_USAGE}`);
  process.exit(2);
}
if (!adminToken) {
  console.error(`ADMIN_TOKEN is not set.\n\n${DEMO_KEY_USAGE}`);
  process.exit(2);
}

try {
  const result = await ensureDemoKey(options, { baseUrl, adminToken, fetch });
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  const limits = `rpm ${options.rpm}, tpm ${options.tpm}, hard budget $${options.budgetUsd}/month, model "${options.alias}"`;
  if (result.key) {
    console.error(
      `Demo key ${result.action} (${result.prefix}…, ${limits}). It is shown once; store it now:`,
    );
    console.log(result.key);
  } else {
    console.error(
      `Demo key ${result.prefix}… already exists in team "${options.team}"; limits updated (${limits}). ` +
        "The plaintext is not stored; use --rotate to replace the key.",
    );
  }
} catch (error) {
  console.error(`demo:key failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
