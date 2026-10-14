/**
 * Release preflight (spec 013, AC-1 and AC-3): the tag must be `v<major>.<minor>.<patch>` with an
 * optional pre-release suffix, match `package.json#version`, and have a non-empty section in
 * `CHANGELOG.md` (Keep a Changelog), whose body becomes the GitHub Release notes.
 */

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)$/;

export interface ReleaseTag {
  version: string;
  prerelease: boolean;
}

export function parseReleaseTag(tag: string): ReleaseTag | undefined {
  const version = TAG.exec(tag)?.[1];
  if (!version || /(^|\.)0\d/.test(version.split("-")[0] ?? "")) return undefined;
  return { version, prerelease: version.includes("-") };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Body of `## [version]` (any date suffix) up to the next `## ` heading or link references. */
export function extractChangelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ") || /^\[[^\]]+\]:\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text === "" ? undefined : text;
}

export type ReleaseCheck =
  | { ok: true; version: string; prerelease: boolean; notes: string }
  | { ok: false; error: string };

export function checkRelease(input: {
  tag: string;
  packageVersion: string;
  changelog: string;
}): ReleaseCheck {
  const tag = parseReleaseTag(input.tag);
  if (!tag) {
    return {
      ok: false,
      error: `tag ${input.tag} is not v<major>.<minor>.<patch> with an optional -suffix`,
    };
  }
  if (tag.version !== input.packageVersion) {
    return {
      ok: false,
      error: `tag ${input.tag} does not match package.json version "${input.packageVersion}"`,
    };
  }
  const notes = extractChangelogSection(input.changelog, tag.version);
  if (!notes) {
    return { ok: false, error: `CHANGELOG.md has no non-empty section for [${tag.version}]` };
  }
  return { ok: true, ...tag, notes };
}
