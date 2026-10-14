// The two generated sections (docs/benchmarks.md and README.md), as `pnpm bench:report` writes
// them and as `--check` and the unit test compare them (spec 012, AC-6).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderDocsSection,
  renderReadmeSection,
  replaceSection,
  type TargetIssues,
} from "./render.ts";
import { loadRuns } from "./runs.ts";

export interface PublishedFile {
  path: string;
  current: string;
  expected: string;
}

export function loadIssues(path: string): TargetIssues {
  if (!existsSync(path)) return { runs: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TargetIssues>;
  return { runs: parsed.runs ?? {} };
}

export function publishedFiles(root: string): PublishedFile[] {
  const loaded = loadRuns(join(root, "bench", "results"));
  const issues = loadIssues(join(root, "bench", "target-issues.json"));
  const sections = [
    { path: "docs/benchmarks.md", name: "results", content: renderDocsSection(loaded, issues) },
    { path: "README.md", name: "readme", content: renderReadmeSection(loaded, issues) },
  ];
  return sections.map(({ path, name, content }) => {
    const current = readFileSync(join(root, path), "utf8");
    return { path, current, expected: replaceSection(current, name, content) };
  });
}
