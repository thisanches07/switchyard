// environment.json of a run (spec 012, AC-5): the machine, versions and images a run measured.
import { cpus, platform, release, totalmem, version } from "node:os";
import { join } from "node:path";
import type { ProfileName } from "./config.ts";
import type { Environment } from "./types.ts";

/** `<UTC yyyymmddThhmmssZ>-<short commit>`, sortable by time. */
export function runId(date: Date, commit: string): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${commit.slice(0, 7)}`;
}

export interface Publishability {
  publishable: boolean;
  reasons: string[];
}

/** Only full runs from a clean tree may be published (AC-5, AC-10). */
export function publishability(kind: ProfileName, dirty: boolean): Publishability {
  const reasons: string[] = [];
  if (kind === "smoke") reasons.push("smoke run (CI correctness check, never published)");
  if (dirty) reasons.push("git working tree was dirty");
  return { publishable: reasons.length === 0, reasons };
}

/**
 * Publishable runs go to `bench/results/<id>/` (committed); the others to the git-ignored
 * `bench/results/local/<id>-<smoke|dirty>/`.
 */
export function runFolder(
  root: string,
  id: string,
  kind: ProfileName,
  status: Publishability,
): string {
  if (status.publishable) return join(root, "bench", "results", id);
  return join(root, "bench", "results", "local", `${id}-${kind === "smoke" ? "smoke" : "dirty"}`);
}

export interface DockerFacts {
  clientVersion: string | null;
  serverVersion: string | null;
  operatingSystem: string | null;
  ncpu: number | null;
  memTotalBytes: number | null;
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** From `docker info --format "{{json .}}"` and `docker version --format "{{json .}}"`. */
export function parseDocker(infoJson: string, versionJson: string): DockerFacts {
  const info = parseObject(infoJson);
  const versions = parseObject(versionJson);
  const client = versions?.Client as { Version?: unknown } | undefined;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    clientVersion: str(client?.Version),
    serverVersion: str(info?.ServerVersion),
    operatingSystem: str(info?.OperatingSystem),
    ncpu: num(info?.NCPU),
    memTotalBytes: num(info?.MemTotal),
  };
}

/**
 * The registry digest of a pulled image, from `docker image inspect --format
 * "{{json .RepoDigests}}"` (`["grafana/k6@sha256:…"]`). Locally built images have none.
 */
export function repoDigest(repoDigestsJson: string): string | null {
  try {
    const list: unknown = JSON.parse(repoDigestsJson);
    if (!Array.isArray(list)) return null;
    const first = list.find((d): d is string => typeof d === "string" && d.includes("@sha256:"));
    return first ? first.slice(first.indexOf("@") + 1) : null;
  } catch {
    return null;
  }
}

export function hostFacts(): Environment["host"] {
  const cores = cpus();
  return {
    cpuModel: cores[0]?.model.trim() ?? "unknown",
    cpuCores: cores.length,
    ramBytes: totalmem(),
    os: { platform: platform(), release: release(), version: version() },
  };
}
