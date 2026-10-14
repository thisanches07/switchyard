// Report generation against FIXTURE run folders (test/fixtures/bench/runs, see generate.ts).
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  batchesOf,
  renderDocsSection,
  renderReadmeSection,
  renderRunSummary,
  replaceSection,
  type TargetIssues,
} from "../../../bench/lib/render.ts";
import { type LoadedRuns, loadRuns } from "../../../bench/lib/runs.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures/bench/runs");
const noIssues: TargetIssues = { runs: {} };
const all = loadRuns(fixtures, { allowFixtures: true });
const batchA: LoadedRuns = {
  runs: all.runs.filter((r) => r.id.endsWith("aaaaaaa")),
  excluded: [],
};
const missedId = "fixture-20260102T000000Z-bbbbbbb";

describe("run folders (AC-5, AC-9)", () => {
  it("publishes clean full runs and lists smoke and dirty ones as excluded", () => {
    expect(all.runs.map((r) => r.id)).toEqual([
      "fixture-20260101T000000Z-aaaaaaa",
      "fixture-20260101T010000Z-aaaaaaa",
      "fixture-20260101T020000Z-aaaaaaa",
      missedId,
    ]);
    expect(all.excluded).toEqual([
      { id: "fixture-20260103T000000Z-ccccccc-dirty", reasons: ["git working tree was dirty"] },
      { id: "fixture-20260103T000000Z-ccccccc-smoke", reasons: ["smoke run"] },
    ]);
  });

  it("refuses fixtures when they are not explicitly allowed (e.g. copied into bench/results)", () => {
    const strict = loadRuns(fixtures);
    expect(strict.runs).toEqual([]);
    expect(strict.excluded[0]?.reasons).toContain("test fixture, not a measurement");
  });

  it("returns nothing for a missing results folder", () => {
    expect(loadRuns(resolve(fixtures, "does-not-exist"))).toEqual({ runs: [], excluded: [] });
  });
});

describe("published tables (AC-6, AC-7, AC-8)", () => {
  it("says there is no published run, with no measured value, when there are none", () => {
    const empty = { runs: [], excluded: [] };
    for (const text of [renderDocsSection(empty, noIssues), renderReadmeSection(empty, noIssues)]) {
      expect(text).toMatch(/No published (benchmark )?run yet/);
      expect(text).toContain("| not measured | not evaluated |");
      // The only digits are the targets' own thresholds (15 ms, 99 %, 30 %): no measurement.
      expect(text.replace(/15 ms|99 %|30 %|AC-\d+|T[12]|p95/g, "")).not.toMatch(/\d/);
    }
  });

  it("groups repeated runs in a batch and marks the median run by T1", () => {
    const [batch] = batchesOf(batchA.runs);
    expect(batch?.runs).toHaveLength(3);
    // Client p95 overheads 8, 6, 7 ms: the median is 7 ms, the third run.
    expect(batch?.runs[batch.median]?.data.id).toBe("fixture-20260101T020000Z-aaaaaaa");
  });

  it("shows every run with T1/T2 met, both overhead measures and the machine", () => {
    const docs = renderDocsSection(batchA, noIssues);
    expect(docs).toContain("`fixture-20260101T020000Z-aaaaaaa` (median)");
    expect(docs).toContain("7.0 ms: **met**");
    expect(docs).toContain("99.96 %: **met**");
    expect(docs).toContain("| no-cache | overhead, client-side | 3.0 ms | 7.0 ms | 25.0 ms |");
    expect(docs).toContain("| no-cache | overhead, server-side | 2.0 ms | 4.0 ms | 6.0 ms |");
    expect(docs).toContain("not available (metric not exported)");
    expect(docs).toContain("hit ratio 99.98 %");
    expect(docs).toContain("FIXTURE CPU (not a real machine)");
    expect(docs).not.toContain("ADR-0021 asks for at least three runs");
    expect(docs.match(/#### Run /g)).toHaveLength(3);
  });

  it("publishes a miss as measured, asking for an issue until one is linked (AC-9)", () => {
    const missed: LoadedRuns = { runs: all.runs.filter((r) => r.id === missedId), excluded: [] };
    const docs = renderDocsSection(missed, noIssues);
    expect(docs).toContain("20.0 ms: **missed**, issue required (AC-9)");
    expect(docs).toContain("98.00 %: **missed**, issue required (AC-9)");
    expect(docs).toContain("this batch has 1");
    const issues: TargetIssues = { runs: { [missedId]: { T1: "https://example.test/issues/1" } } };
    expect(renderDocsSection(missed, issues)).toContain(
      "20.0 ms: **missed** ([issue](https://example.test/issues/1))",
    );
    expect(renderReadmeSection(missed, issues)).toContain("**missed**");
  });

  it("puts the latest batch's median run in the README, never claiming a missed target", () => {
    const readme = renderReadmeSection(batchA, noIssues);
    expect(readme).toContain("Median of 3 run(s), run `fixture-20260101T020000Z-aaaaaaa`");
    expect(readme).toContain(
      "| p95 gateway overhead, no cache (client-side) | 7.0 ms | 7.0 ms: **met** |",
    );
    expect(readme).toContain(
      "| p95 gateway overhead, no cache (server-side) | 4.0 ms | cross-check |",
    );
    expect(readme).toContain("docs/benchmarks.md");
    // With every fixture loaded the newest batch is the one that misses both targets.
    const latest = renderReadmeSection(all, noIssues);
    expect(latest).toContain(missedId);
    expect(latest).not.toContain("**met**");
  });

  it("lists excluded runs with their reasons", () => {
    expect(renderDocsSection(all, noIssues)).toContain(
      "- `fixture-20260103T000000Z-ccccccc-smoke`: smoke run",
    );
  });

  it("writes a run summary with publishability and correctness", () => {
    const run = all.runs[0];
    if (!run) throw new Error("fixture missing");
    const summary = renderRunSummary(run, noIssues);
    expect(summary).toContain("# Benchmark run `fixture-20260101T000000Z-aaaaaaa`");
    expect(summary).toContain("publishable (clean full run)");
    expect(summary).toContain("no-cache passed");
  });
});

describe("generated sections", () => {
  it("replaces only the text between the markers", () => {
    const text = "a\n<!-- bench:x:start -->\nold\n<!-- bench:x:end -->\nb";
    expect(replaceSection(text, "x", "new")).toBe(
      "a\n<!-- bench:x:start -->\nnew\n<!-- bench:x:end -->\nb",
    );
    expect(() => replaceSection("no markers", "x", "new")).toThrow(/not found/);
  });
});
