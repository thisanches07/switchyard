import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderTemplate } from "../../../scripts/lib/cloud-init.ts";

const root = resolve(import.meta.dirname, "../../..");
const template = readFileSync(resolve(root, "deploy/terraform/cloud-init.yaml.tftpl"), "utf8");
const open = "$" + "{";

describe("renderTemplate (templatefile subset)", () => {
  it("substitutes plain variables", () => {
    expect(renderTemplate(`v=${open}version}!`, { version: "1.2.3" })).toBe("v=1.2.3!");
  });

  it("keeps escaped sequences literal", () => {
    expect(renderTemplate(`a=$${open}HOME} b=%%{x}`, {})).toBe(`a=${open}HOME} b=%{x}`);
  });

  it("refuses unknown variables, expressions and directives", () => {
    expect(() => renderTemplate(`${open}other}`, { version: "1" })).toThrow(/unknown template/);
    expect(() => renderTemplate(`${open}upper(x)}`, {})).toThrow(/unsupported/);
    expect(() => renderTemplate("%{ if x }", {})).toThrow(/directives/);
  });

  it("leaves shell variables without braces alone", () => {
    expect(renderTemplate('echo "$version" $(date)', {})).toBe('echo "$version" $(date)');
  });
});

describe("VM cloud-init (spec 013, AC-9)", () => {
  const rendered = renderTemplate(template, { switchyard_version: "0.1.0" });
  const config = parse(rendered) as {
    packages: string[];
    ssh_pwauth: boolean;
    disable_root: boolean;
    apt: { sources: Record<string, { source: string }> };
    write_files: { path: string; content: string; permissions?: string }[];
    runcmd: string[];
  };
  const file = (path: string) => config.write_files.find((f) => f.path === path)?.content ?? "";

  it("is a cloud-config document with only switchyard_version as a variable", () => {
    expect(rendered.startsWith("#cloud-config\n")).toBe(true);
    expect(() => renderTemplate(template, {})).toThrow(/switchyard_version/);
  });

  it("installs Docker Engine with the Compose plugin from Docker's repository", () => {
    expect(config.apt.sources["docker.list"]?.source).toContain("download.docker.com/linux/ubuntu");
    for (const pkg of ["docker-ce", "containerd.io", "docker-compose-plugin"]) {
      expect(config.packages).toContain(pkg);
    }
  });

  it("enables automatic security updates", () => {
    expect(config.packages).toContain("unattended-upgrades");
    expect(file("/etc/apt/apt.conf.d/20auto-upgrades")).toContain(
      'APT::Periodic::Unattended-Upgrade "1";',
    );
  });

  it("allows key-only SSH login", () => {
    expect(config.ssh_pwauth).toBe(false);
    expect(config.disable_root).toBe(true);
    const sshd = file("/etc/ssh/sshd_config.d/60-switchyard.conf");
    expect(sshd).toContain("PasswordAuthentication no");
    expect(sshd).toContain("KbdInteractiveAuthentication no");
    expect(sshd).toContain("PermitRootLogin no");
  });

  it("installs the production Compose bundle of the given version", () => {
    expect(config.runcmd).toContain("/usr/local/bin/switchyard-fetch 0.1.0");
    const fetch = file("/usr/local/bin/switchyard-fetch");
    expect(fetch).toContain(
      "https://raw.githubusercontent.com/thisanches07/switchyard/v$version/deploy/compose",
    );
    for (const name of [
      "compose.yml",
      "Caddyfile",
      "config/switchyard.yaml",
      "config/pricing.yaml",
    ]) {
      expect(fetch).toContain(name);
    }
  });

  it("starts the stack through systemd once the operator has provided the env file", () => {
    expect(file("/etc/systemd/system/switchyard.path")).toContain(
      "PathExists=/etc/switchyard/switchyard.env",
    );
    const service = file("/etc/systemd/system/switchyard.service");
    expect(service).toContain("ConditionPathExists=/etc/switchyard/switchyard.env");
    expect(service).toContain("docker compose --env-file /etc/switchyard/switchyard.env");
    expect(config.runcmd.join("\n")).toContain(
      "systemctl enable --now docker.service switchyard.path",
    );
  });

  it("carries no secret", () => {
    for (const secret of ["ADMIN_TOKEN=", "KEY_PEPPER=", "POSTGRES_PASSWORD=", "API_KEY="]) {
      expect(rendered).not.toContain(secret);
    }
  });
});
