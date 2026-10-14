import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../../../src/config/load.js";
import { loadPricing } from "../../../src/modules/pricing/load.js";
import { unknownPriceCandidates } from "../../../src/modules/pricing/table.js";

const root = resolve(import.meta.dirname, "../../..");
const dir = resolve(root, "deploy/compose");
const text = readFileSync(resolve(dir, "compose.yml"), "utf8");

interface Service {
  image?: string;
  build?: unknown;
  ports?: string[];
  expose?: unknown;
  environment?: Record<string, string>;
  network_mode?: string;
  profiles?: string[];
}
const compose = parse(text, { merge: true }) as {
  services: Record<string, Service>;
  networks: { default: { ipam: { config: { subnet: string }[] } } };
};
const services = compose.services;

describe("production Compose file (spec 013, AC-4)", () => {
  it("runs the stack's services", () => {
    expect(Object.keys(services).sort()).toEqual(
      [
        "caddy",
        "gateway",
        "lgtm",
        "ollama",
        "postgres",
        "redis",
        "redpanda",
        "usage-worker",
      ].sort(),
    );
  });

  it("never builds: every service runs a pinned image", () => {
    for (const [name, service] of Object.entries(services)) {
      expect(service.build, name).toBeUndefined();
      expect(service.image, name).toMatch(
        /^[a-z0-9./-]+:(\d[\w.-]*|v\d[\w.-]*|\$\{SWITCHYARD_VERSION:\?.+\})$/,
      );
      expect(service.image, name).not.toMatch(/:latest$/);
    }
  });

  it("runs the published gateway and worker images by version", () => {
    const tag = /:\$\{SWITCHYARD_VERSION:\?[^}]+\}$/;
    expect(services.gateway?.image).toMatch(/^ghcr\.io\/thisanches07\/switchyard-gateway/);
    expect(services.gateway?.image).toMatch(tag);
    expect(services["usage-worker"]?.image).toMatch(/^ghcr\.io\/thisanches07\/switchyard-worker/);
    expect(services["usage-worker"]?.image).toMatch(tag);
  });

  it("publishes only ports 80 and 443, and only on the proxy", () => {
    for (const [name, service] of Object.entries(services)) {
      if (name === "caddy") continue;
      expect(service.ports, name).toBeUndefined();
      expect(service.network_mode, name).toBeUndefined();
    }
    expect(services.caddy?.ports).toEqual(["80:80", "443:443"]);
  });

  it("takes every secret from the env file, required, without defaults", () => {
    const gateway = services.gateway?.environment ?? {};
    expect(gateway.ADMIN_TOKEN).toMatch(/^\$\{ADMIN_TOKEN:\?/);
    expect(gateway.KEY_PEPPER).toMatch(/^\$\{KEY_PEPPER:\?/);
    expect(gateway.DATABASE_URL).toContain("${POSTGRES_PASSWORD:?");
    expect(services.postgres?.environment?.POSTGRES_PASSWORD).toMatch(/^\$\{POSTGRES_PASSWORD:\?/);
    expect(services["usage-worker"]?.environment?.DATABASE_URL).toContain("${POSTGRES_PASSWORD:?");
    for (const provider of ["GROQ", "GEMINI", "OPENAI", "ANTHROPIC", "OPENROUTER"]) {
      expect(gateway[`${provider}_API_KEY`]).toBe(`\${${provider}_API_KEY:-}`);
    }
  });

  it("contains none of the dev defaults of docker-compose.yml", () => {
    expect(text).not.toContain("dev-only");
    expect(text).not.toMatch(/switchyard:switchyard@/);
    expect(text).not.toMatch(/POSTGRES_PASSWORD: switchyard/);
  });

  it("makes the gateway refuse dev and placeholder secrets", () => {
    expect(services.gateway?.environment?.SWITCHYARD_REQUIRE_SECRETS).toBe("true");
  });

  it("gives the gateway and Grafana fixed addresses for the SSH tunnel", () => {
    expect(compose.networks.default.ipam.config[0]?.subnet).toBe("172.30.0.0/24");
    expect(text).toContain("ipv4_address: 172.30.0.10");
    expect(text).toContain("ipv4_address: 172.30.0.20");
  });

  it("keeps Ollama optional", () => {
    expect(services.ollama?.profiles).toEqual(["ollama"]);
  });
});

describe("Caddyfile (spec 013, AC-4 and AC-5)", () => {
  const caddyfile = readFileSync(resolve(dir, "Caddyfile"), "utf8");

  it("serves the configured hostname and proxies to the gateway", () => {
    expect(caddyfile).toMatch(/^\{\$SWITCHYARD_HOSTNAME\} \{$/m);
    expect(caddyfile).toContain("reverse_proxy gateway:8080");
    expect(caddyfile).toContain("flush_interval -1");
  });

  it("keeps the admin API off the public endpoint", () => {
    expect(caddyfile).toMatch(/handle \/admin\* \{[^}]*respond[^\n]*404/s);
  });

  it("speaks HTTP/1.1 and HTTP/2 only (no UDP port for HTTP/3)", () => {
    expect(caddyfile).toMatch(/protocols h1 h2$/m);
  });
});

describe("demo configuration (spec 013)", () => {
  const config = loadConfig(resolve(dir, "config/switchyard.yaml"), {});

  it("is a valid gateway configuration behind a trusted proxy", () => {
    expect(config.server.trustProxy).toBe(true);
    expect(config.pricingFile).toBe("/config/pricing.yaml");
  });

  it("serves the demo alias from free models only, all priced", () => {
    expect(Object.keys(config.aliases)).toEqual(["demo"]);
    const pricing = loadPricing(resolve(dir, "config/pricing.yaml"));
    expect(unknownPriceCandidates(config.aliases, pricing)).toEqual([]);
    for (const candidate of config.aliases.demo?.candidates ?? []) {
      expect(candidate).toMatch(/^(mock|ollama)\//);
    }
  });

  it("the CI-only pricing override is valid and prices the mock models (AC-6)", () => {
    const pricing = loadPricing(resolve(root, "test/deploy/pricing.test.yaml"));
    expect(unknownPriceCandidates(config.aliases, pricing)).toEqual([]);
    const override = parse(readFileSync(resolve(root, "test/deploy/compose.test.yml"), "utf8")) as {
      services: Record<string, { volumes: string[] }>;
    };
    expect(override.services.gateway?.volumes).toEqual([
      "../../test/deploy/pricing.test.yaml:/config/pricing.yaml:ro",
    ]);
  });

  it("fails closed when Redis is down", () => {
    expect(config.limits.onRedisError).toBe("closed");
    expect(config.budgets.onRedisError).toBe("closed");
  });

  it("the env example holds placeholders only", () => {
    const example = readFileSync(resolve(dir, "switchyard.env.example"), "utf8");
    const values = Object.fromEntries(
      example
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => line.split("=", 2) as [string, string]),
    );
    for (const secret of ["ADMIN_TOKEN", "KEY_PEPPER", "POSTGRES_PASSWORD"]) {
      expect(values[secret]).toMatch(/^replace-me/);
    }
    for (const key of Object.keys(values).filter((k) => k.endsWith("_API_KEY"))) {
      expect(values[key]).toBe("");
    }
  });
});
