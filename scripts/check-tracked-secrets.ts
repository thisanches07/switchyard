// Fails when git tracks Terraform state, variable files or environment files (spec 013, AC-10).
// Cross-platform: `node scripts/check-tracked-secrets.ts` (run by CI on every pull request).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { findTrackedSecrets } from "./lib/tracked-secrets.ts";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
const found = findTrackedSecrets(files);

if (found.length > 0) {
  console.error("These tracked files must not be committed (see .gitignore):");
  for (const { path, reason } of found) console.error(`  ${path}  (${reason})`);
  console.error("Remove them with `git rm --cached <path>` and rotate any secret they contained.");
  process.exit(1);
}
console.log(`No Terraform state, tfvars or environment files tracked (${files.length} files).`);
