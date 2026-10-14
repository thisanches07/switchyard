import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findTrackedSecrets } from "../../../scripts/lib/tracked-secrets.ts";

const root = resolve(import.meta.dirname, "../../..");

describe("tracked secrets check (spec 013, AC-10)", () => {
  it.each([
    ["deploy/terraform/terraform.tfstate", "Terraform state"],
    ["deploy/terraform/terraform.tfstate.backup", "Terraform state"],
    [
      "deploy/terraform/.terraform/providers/x/terraform-provider-oci",
      "Terraform working directory",
    ],
    ["deploy/terraform/.terraform.tfstate.lock.info", "Terraform state"],
    ["deploy/terraform/terraform.tfvars", "Terraform variables"],
    ["deploy/terraform/prod.auto.tfvars.json", "Terraform variables"],
    ["deploy/terraform/demo.tfplan", "Terraform plan file"],
    [".env", "environment file"],
    [".env.production", "environment file"],
    ["deploy/compose/switchyard.env", "environment file"],
    ["deploy\\compose\\prod.env", "environment file"],
    ["deploy/terraform/crash.log", "Terraform crash log"],
  ])("flags %s", (path, reason) => {
    expect(findTrackedSecrets([path])).toEqual([{ path: path.replace(/\\/g, "/"), reason }]);
  });

  it.each([
    "deploy/terraform/.terraform.lock.hcl",
    "deploy/terraform/terraform.tfvars.example",
    "deploy/compose/switchyard.env.example",
    ".env.example",
    "deploy/terraform/main.tf",
    "src/config/env.ts",
    "docs/deploy.md",
  ])("allows %s", (path) => {
    expect(findTrackedSecrets([path])).toEqual([]);
  });

  it("the repository tracks no such file", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
    expect(findTrackedSecrets(files)).toEqual([]);
  });
});
