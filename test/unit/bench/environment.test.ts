import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hostFacts,
  parseDocker,
  publishability,
  repoDigest,
  runFolder,
  runId,
} from "../../../bench/lib/environment.ts";

describe("run identity and folder (AC-5)", () => {
  it("builds a sortable run id from the UTC time and the short commit", () => {
    expect(runId(new Date("2026-10-13T09:05:07.123Z"), "abcdef1234567")).toBe(
      "20261013T090507Z-abcdef1",
    );
  });

  it("publishes only full runs from a clean tree", () => {
    expect(publishability("full", false)).toEqual({ publishable: true, reasons: [] });
    expect(publishability("full", true)).toEqual({
      publishable: false,
      reasons: ["git working tree was dirty"],
    });
    expect(publishability("smoke", true).reasons).toHaveLength(2);
  });

  it("routes unpublishable runs to the git-ignored results/local folder", () => {
    const clean = publishability("full", false);
    expect(runFolder("/repo", "id1", "full", clean)).toBe(join("/repo", "bench/results/id1"));
    expect(runFolder("/repo", "id1", "full", publishability("full", true))).toBe(
      join("/repo", "bench/results/local/id1-dirty"),
    );
    expect(runFolder("/repo", "id1", "smoke", publishability("smoke", false))).toBe(
      join("/repo", "bench/results/local/id1-smoke"),
    );
  });
});

describe("environment facts (AC-5)", () => {
  it("reads Docker version and resources", () => {
    const info = JSON.stringify({
      ServerVersion: "29.1.0",
      OperatingSystem: "Docker Desktop",
      NCPU: 4,
      MemTotal: 8_250_000_000,
    });
    const version = JSON.stringify({ Client: { Version: "29.1.0" }, Server: {} });
    expect(parseDocker(info, version)).toEqual({
      clientVersion: "29.1.0",
      serverVersion: "29.1.0",
      operatingSystem: "Docker Desktop",
      ncpu: 4,
      memTotalBytes: 8_250_000_000,
    });
    expect(parseDocker("garbage", "")).toEqual({
      clientVersion: null,
      serverVersion: null,
      operatingSystem: null,
      ncpu: null,
      memTotalBytes: null,
    });
  });

  it("extracts the registry digest of a pulled image, none for local builds", () => {
    expect(repoDigest('["grafana/k6@sha256:23f2"]')).toBe("sha256:23f2");
    expect(repoDigest("[]")).toBeNull();
    expect(repoDigest("not json")).toBeNull();
  });

  it("describes the host", () => {
    const host = hostFacts();
    expect(host.cpuCores).toBeGreaterThan(0);
    expect(host.ramBytes).toBeGreaterThan(0);
    expect(host.os.platform).toBe(process.platform);
  });
});
