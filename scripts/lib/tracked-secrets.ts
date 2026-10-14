/**
 * Files that must never be committed (spec 013, AC-10): Terraform state and working directories,
 * variable files with real values, and environment files. Examples with placeholder values and
 * the provider lock file are allowed.
 */

const RULES: { reason: string; test: (path: string, name: string) => boolean }[] = [
  { reason: "Terraform working directory", test: (p) => /(^|\/)\.terraform\//.test(p) },
  {
    reason: "Terraform state",
    test: (_p, n) => /\.tfstate(\.|$)/.test(n) || n === ".terraform.tfstate.lock.info",
  },
  { reason: "Terraform plan file", test: (_p, n) => n.endsWith(".tfplan") },
  {
    reason: "Terraform variables",
    test: (_p, n) => /\.tfvars(\.json)?$/.test(n),
  },
  {
    reason: "environment file",
    test: (_p, n) => (n === ".env" || n.startsWith(".env.") || n.endsWith(".env")) && !isExample(n),
  },
  { reason: "Terraform crash log", test: (_p, n) => n === "crash.log" },
];

function isExample(name: string): boolean {
  return /\.example$/.test(name);
}

export interface TrackedSecret {
  path: string;
  reason: string;
}

/** Paths (as printed by `git ls-files`) that match a forbidden pattern. */
export function findTrackedSecrets(paths: readonly string[]): TrackedSecret[] {
  const found: TrackedSecret[] = [];
  for (const raw of paths) {
    const path = raw.replace(/\\/g, "/").trim();
    if (path === "") continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const rule = RULES.find((r) => r.test(path, name));
    if (rule) found.push({ path, reason: rule.reason });
  }
  return found;
}
