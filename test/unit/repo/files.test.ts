import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

const requiredFiles = [
  ".gitattributes",
  ".editorconfig",
  ".nvmrc",
  ".gitignore",
  ".env.example",
  "LICENSE",
  "config/switchyard.example.yaml",
  ".vscode/extensions.json",
];

describe("repository files", () => {
  it.each(requiredFiles)("required repository file exists: %s", (file) => {
    expect(existsSync(resolve(root, file))).toBe(true);
  });

  it("gitattributes enforces LF", () => {
    const content = readFileSync(resolve(root, ".gitattributes"), "utf8");
    expect(content).toMatch(/^\* text=auto eol=lf$/m);
  });

  it("nvmrc pins Node 24", () => {
    expect(readFileSync(resolve(root, ".nvmrc"), "utf8").trim()).toBe("24");
  });
});

describe("deploy documentation (spec 013, AC-11 and AC-12)", () => {
  const read = (file: string) => readFileSync(resolve(root, file), "utf8");

  it.each([
    "CHANGELOG.md",
    "docs/deploy.md",
    "deploy/compose/compose.yml",
    "deploy/compose/Caddyfile",
    "deploy/compose/switchyard.env.example",
    "deploy/terraform/.terraform.lock.hcl",
    "deploy/terraform/terraform.tfvars.example",
  ])("deploy file exists: %s", (file) => {
    expect(existsSync(resolve(root, file))).toBe(true);
  });

  it("the runbook covers every required topic", () => {
    const runbook = read("docs/deploy.md");
    for (const topic of [
      /credit card/i,
      /capacity/i,
      /API key/,
      /ssh-keygen/,
      /terraform init/,
      /terraform plan/,
      /terraform apply/,
      /environment file over SSH/i,
      /sslip\.io/,
      /pnpm demo:key/,
      /\/healthz/,
      /SSH tunnel/i,
      /Grafana/,
      /Upgrade to a new release/i,
      /Roll back/i,
      /terraform destroy/,
      /billing alert/i,
      /ADR-0022/,
    ]) {
      expect(runbook).toMatch(topic);
    }
    expect(runbook).toContain("Not yet run against a real account");
  });

  it("the README documents the published images and links the runbook", () => {
    const readme = read("README.md");
    expect(readme).toContain("ghcr.io/thisanches07/switchyard-gateway");
    expect(readme).toContain("ghcr.io/thisanches07/switchyard-worker");
    expect(readme).toContain("linux/amd64");
    expect(readme).toContain("linux/arm64");
    expect(readme).toContain("(docs/deploy.md)");
  });

  it("the changelog follows Keep a Changelog with an Unreleased section", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).toMatch(/^# Changelog$/m);
    expect(changelog).toContain("keepachangelog.com");
    expect(changelog).toMatch(/^## \[Unreleased\]$/m);
    expect(changelog).toMatch(/^## \[0\.\d+\.\d+\]/m);
  });
});
