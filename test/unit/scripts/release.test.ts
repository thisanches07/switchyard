import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkRelease,
  extractChangelogSection,
  parseReleaseTag,
} from "../../../scripts/lib/release.ts";

const root = resolve(import.meta.dirname, "../../..");

const changelog = `# Changelog

## [Unreleased]

### Added
- Something after 0.2.0.

## [0.2.0-rc.1] - 2026-11-01

### Fixed
- A pre-release fix.

## [0.1.0] - 2026-10-20

### Added
- First release.

[Unreleased]: https://example.invalid/compare
[0.1.0]: https://example.invalid/tag
`;

describe("release tag parsing (spec 013, AC-1)", () => {
  it("parses a plain version tag", () => {
    expect(parseReleaseTag("v0.1.0")).toEqual({ version: "0.1.0", prerelease: false });
  });

  it("flags tags with a pre-release suffix", () => {
    expect(parseReleaseTag("v1.2.3-rc.1")).toEqual({ version: "1.2.3-rc.1", prerelease: true });
  });

  it.each(["0.1.0", "v1.2", "v1.2.3.4", "v01.2.3x", "vX.Y.Z", "v1.2.3-", "refs/tags/v1.2.3"])(
    "rejects %s",
    (tag) => {
      expect(parseReleaseTag(tag)).toBeUndefined();
    },
  );
});

describe("changelog section (spec 013, AC-3)", () => {
  it("extracts the body of the matching section, ignoring the date", () => {
    expect(extractChangelogSection(changelog, "0.1.0")).toBe("### Added\n- First release.");
  });

  it("extracts a pre-release section up to the next heading", () => {
    expect(extractChangelogSection(changelog, "0.2.0-rc.1")).toBe(
      "### Fixed\n- A pre-release fix.",
    );
  });

  it("does not match a version that only shares a prefix", () => {
    expect(extractChangelogSection(changelog, "0.1")).toBeUndefined();
    expect(extractChangelogSection(changelog, "0.2.0")).toBeUndefined();
  });

  it("returns undefined for a missing or empty section", () => {
    expect(extractChangelogSection(changelog, "9.9.9")).toBeUndefined();
    expect(extractChangelogSection("## [1.0.0]\n\n## [0.9.0]\n- x\n", "1.0.0")).toBeUndefined();
  });
});

describe("release check (spec 013, AC-1 and AC-3)", () => {
  it("accepts a tag that matches package.json with a changelog section", () => {
    const result = checkRelease({ tag: "v0.1.0", packageVersion: "0.1.0", changelog });
    expect(result).toEqual({
      ok: true,
      version: "0.1.0",
      prerelease: false,
      notes: "### Added\n- First release.",
    });
  });

  it("rejects a tag that does not match package.json", () => {
    const result = checkRelease({ tag: "v0.2.0", packageVersion: "0.1.0", changelog });
    expect(result).toEqual({
      ok: false,
      error: 'tag v0.2.0 does not match package.json version "0.1.0"',
    });
  });

  it("rejects a malformed tag", () => {
    const result = checkRelease({ tag: "release-1", packageVersion: "0.1.0", changelog });
    expect(result.ok).toBe(false);
  });

  it("rejects a release without a changelog section", () => {
    const result = checkRelease({ tag: "v0.3.0", packageVersion: "0.3.0", changelog });
    expect(result).toEqual({
      ok: false,
      error: "CHANGELOG.md has no non-empty section for [0.3.0]",
    });
  });

  it("the repository is ready for its first tag (package.json and CHANGELOG.md agree)", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    const result = checkRelease({
      tag: `v${pkg.version}`,
      packageVersion: pkg.version,
      changelog: readFileSync(resolve(root, "CHANGELOG.md"), "utf8"),
    });
    expect(result.ok).toBe(true);
    expect(pkg.version).toMatch(/^0\.\d+\.\d+$/);
  });
});
