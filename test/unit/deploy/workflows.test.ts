import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
/** A GitHub Actions expression such as `${{ matrix.target }}`, without a template-like literal. */
const gh = (expr: string) => `$${"{{"} ${expr} }}`;

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  if?: string;
  id?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  env?: Record<string, string>;
}
interface Workflow {
  on: Record<string, { tags?: string[]; paths?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const load = (name: string) => {
  const text = readFileSync(resolve(root, ".github/workflows", name), "utf8");
  return { text, workflow: parse(text) as Workflow };
};

const release = load("release.yml");
const deploy = load("deploy.yml");

describe("release workflow (spec 013, AC-1 and AC-3)", () => {
  const { jobs } = release.workflow;

  it("runs on v* tags and by hand (dry run)", () => {
    expect(release.workflow.on.push?.tags).toEqual(["v*"]);
    expect(release.workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("checks tag, version and changelog before building anything", () => {
    expect(jobs.preflight?.steps.some((s) => s.run?.includes("scripts/release-check.ts"))).toBe(
      true,
    );
    expect(jobs.images?.needs).toBe("preflight");
    expect(jobs["github-release"]?.needs).toEqual(["preflight", "images"]);
  });

  it("builds both images for amd64 and arm64 with QEMU and pushes only for tag pushes", () => {
    const images = jobs.images;
    const build = images?.steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
    expect(build?.with?.platforms).toBe("linux/amd64,linux/arm64");
    expect(build?.with?.target).toBe(gh("matrix.target"));
    expect(build?.with?.push).toBe(gh("env.PUSH == 'true'"));
    expect(images?.env?.PUSH).toBe(gh("github.event_name == 'push' && github.ref_type == 'tag'"));
    expect(images?.steps.some((s) => s.uses?.startsWith("docker/setup-qemu-action@"))).toBe(true);
    expect(images?.permissions).toEqual({ contents: "read", packages: "write" });
  });

  it("tags X.Y.Z, X.Y and latest on ghcr.io/thisanches07 with OCI labels", () => {
    const meta = jobs.images?.steps.find((s) => s.id === "meta");
    expect(meta?.with?.images).toBe(`ghcr.io/thisanches07/switchyard-${gh("matrix.target")}`);
    expect(meta?.with?.tags).toContain("pattern={{version}}");
    expect(meta?.with?.tags).toContain("pattern={{major}}.{{minor}}");
    expect(meta?.with?.flavor).toBe("latest=auto");
    const build = jobs.images?.steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
    expect(build?.with?.labels).toBe(gh("steps.meta.outputs.labels"));
  });

  it("creates the GitHub Release from the changelog notes, only for tags", () => {
    const job = jobs["github-release"];
    expect(job?.if).toBe("github.event_name == 'push' && github.ref_type == 'tag'");
    expect(job?.permissions).toEqual({ contents: "write" });
    expect(job?.steps.at(-1)?.run).toContain("--notes-file release-notes.md");
  });

  it("is read-only by default", () => {
    expect(release.workflow.permissions).toEqual({ contents: "read" });
  });
});

describe("deploy workflow (spec 013, AC-2, AC-5, AC-8, AC-9)", () => {
  const { jobs } = deploy.workflow;

  it("runs when the Dockerfile, deploy/ or the release workflow change", () => {
    const paths = deploy.workflow.on.pull_request?.paths ?? [];
    for (const path of ["Dockerfile", "deploy/**", ".github/workflows/release.yml"]) {
      expect(paths).toContain(path);
    }
  });

  it("builds both platforms without pushing", () => {
    const build = jobs["images-multiarch"]?.steps.find((s) =>
      s.uses?.startsWith("docker/build-push-action@"),
    );
    expect(build?.with?.platforms).toBe("linux/amd64,linux/arm64");
    expect(build?.with?.push).toBe(false);
    expect(deploy.text).not.toMatch(/push: true/);
    expect(deploy.text).not.toContain("docker/login-action");
  });

  it("runs the amd64 images in both Compose stacks", () => {
    expect(jobs["images-compose"]?.steps.at(-1)?.run).toBe("node scripts/compose-smoke.ts --down");
    expect(jobs["prod-compose"]?.steps.at(-1)?.run).toBe("node scripts/deploy-smoke.ts --down");
  });

  it("runs terraform fmt, init -backend=false and validate, never plan or apply", () => {
    const runs = jobs.terraform?.steps.map((s) => s.run).filter(Boolean) ?? [];
    expect(runs).toContain("terraform fmt -check -recursive");
    expect(runs).toContain("terraform init -backend=false -input=false -lockfile=readonly");
    expect(runs).toContain("terraform validate");
    expect(runs.join("\n")).not.toMatch(/terraform (plan|apply)/);
  });

  it("validates the rendered cloud-init", () => {
    const runs = jobs["cloud-init"]?.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("scripts/render-cloud-init.ts");
    expect(runs).toContain("cloud-init schema --config-file");
  });
});

describe("pinned actions (spec 013)", () => {
  it.each([
    ["release.yml", release.text],
    ["deploy.yml", deploy.text],
  ])("%s pins every action to a full commit SHA with its version", (_name, text) => {
    const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, comment] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(comment).toMatch(/# v\d+\.\d+\.\d+/);
    }
  });
});
