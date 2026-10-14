// Renders the VM's cloud-init the way Terraform does (spec 013, AC-9), for `cloud-init schema`
// in CI. Cross-platform: `node scripts/render-cloud-init.ts [--version 0.1.0] [--out file]`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderTemplate } from "./lib/cloud-init.ts";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { version: { type: "string" }, out: { type: "string" } },
});
const version =
  values.version ??
  (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;

const rendered = renderTemplate(
  readFileSync(resolve(root, "deploy/terraform/cloud-init.yaml.tftpl"), "utf8"),
  { switchyard_version: version },
);
if (values.out) {
  writeFileSync(values.out, rendered);
  console.log(`cloud-init for v${version} written to ${values.out}`);
} else {
  process.stdout.write(rendered);
}
