// Release preflight (spec 013, AC-1 and AC-3), run by the release workflow before any image is
// pushed. Cross-platform: `node scripts/release-check.ts --tag v0.1.0 [--notes notes.md]`.
// Without --tag it checks the tag the current package.json version would need.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkRelease } from "./lib/release.ts";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { tag: { type: "string" }, notes: { type: "string" } },
});

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
const tag = values.tag ?? `v${pkg.version}`;
const result = checkRelease({
  tag,
  packageVersion: pkg.version,
  changelog: readFileSync(resolve(root, "CHANGELOG.md"), "utf8"),
});

if (!result.ok) {
  console.error(`Release check failed: ${result.error}`);
  process.exit(1);
}

if (values.notes) writeFileSync(values.notes, `${result.notes}\n`);
// GitHub Actions step outputs.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${result.version}\nprerelease=${result.prerelease}\ntag=${tag}\n`,
  );
}
console.log(
  `Release check passed: ${tag} (version ${result.version}${result.prerelease ? ", pre-release" : ""})`,
);
