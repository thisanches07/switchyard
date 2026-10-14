import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
/** A Compose interpolation such as `${NAME:-default}`, written without a template-like literal. */
const interp = (expr: string) => `$${"{"}${expr}}`;
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");

/** Stage name → its lines (FROM line included). */
function stages(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of dockerfile.split("\n")) {
    const from = /^FROM\s+.+\s+AS\s+(\S+)\s*$/i.exec(line);
    if (from?.[1]) {
      current = [line];
      result.set(from[1], current);
    } else if (current && line.trim() && !line.startsWith("#")) {
      current.push(line);
    }
  }
  return result;
}

describe("Dockerfile (spec 013, AC-1)", () => {
  const all = stages();

  it("has gateway and worker targets built on the shared runtime stage", () => {
    expect(all.get("gateway")?.[0]).toMatch(/^FROM runtime AS gateway$/);
    expect(all.get("worker")?.[0]).toMatch(/^FROM runtime AS worker$/);
  });

  it("makes the gateway the default (last) target", () => {
    expect([...all.keys()].at(-1)).toBe("gateway");
  });

  it("gives each target its own command, and the gateway a health check", () => {
    const gateway = all.get("gateway")?.join("\n") ?? "";
    const worker = all.get("worker")?.join("\n") ?? "";
    expect(gateway).toContain('"dist/server.js"');
    expect(gateway).toContain("HEALTHCHECK");
    expect(gateway).toContain("/healthz");
    expect(worker).toContain('"dist/worker.js"');
    expect(worker).not.toContain("HEALTHCHECK");
  });

  it("compiles TypeScript on the build platform, not under emulation", () => {
    expect(all.get("build")?.[0]).toMatch(/^FROM --platform=\$BUILDPLATFORM /);
  });

  it("pins the Node base image to an exact version", () => {
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:24\.\d+\.\d+-bookworm-slim$/m);
  });

  it("runs as the unprivileged node user", () => {
    expect(all.get("runtime")?.join("\n")).toContain("USER node");
  });
});

describe("dev Compose stack uses the two targets (spec 013, AC-2)", () => {
  const compose = parse(readFileSync(resolve(root, "docker-compose.yml"), "utf8")) as {
    services: Record<string, { build?: { target?: string }; image?: string; command?: unknown }>;
  };

  it("builds the gateway and worker targets and lets CI substitute prebuilt images", () => {
    const { gateway, "usage-worker": worker } = compose.services;
    expect(gateway?.build?.target).toBe("gateway");
    expect(gateway?.image).toBe(interp("SWITCHYARD_GATEWAY_IMAGE:-switchyard-gateway:dev"));
    expect(worker?.build?.target).toBe("worker");
    expect(worker?.image).toBe(interp("SWITCHYARD_WORKER_IMAGE:-switchyard-worker:dev"));
    expect(worker?.command).toBeUndefined();
  });
});
