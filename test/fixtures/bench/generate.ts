// Regenerates test/fixtures/bench/runs/ (spec 012 report tests): `npx tsx test/fixtures/bench/generate.ts`.
// FIXTURES, not measurements: every folder is named `fixture-*`, its environment.json has
// `fixture: true` and a fake machine, and the report refuses such runs under bench/results/.
import { join } from "node:path";
import { ensureDir, FILES, writeJson } from "../../../bench/lib/runs.ts";
import { makeRun, type RunSpec } from "../../helpers/bench.ts";

const out = join(import.meta.dirname, "runs");
const commitA = "aaaaaaa0000000000000000000000000fixture0";
const commitB = "bbbbbbb0000000000000000000000000fixture0";
type Triple = [number, number, number];

function full(
  id: string,
  commit: string,
  gateway: Triple,
  chaos: { requests: number; ok: number },
  serverNoCache: Triple | null,
): RunSpec {
  return {
    id,
    environment: { git: { commit, dirty: false } },
    summaries: {
      "no-cache.direct": { latency: [50, 60, 70], requests: 6000 },
      "no-cache.gateway": { latency: gateway, requests: 6000 },
      "exact-cache.gateway": {
        latency: [2, 3, 5],
        requests: 6000,
        cache: { hit: 5999, miss: 1, unlabelled: 0 },
      },
      "streaming.direct": { latency: [190, 200, 210], ttfb: [52, 55, 60], requests: 2400 },
      "streaming.gateway": { latency: [195, 206, 230], ttfb: [55, 60, 75], requests: 2400 },
      "rate-limited.gateway": {
        latency: [55, 60, 70],
        rejectLatency: [1, 2, 4],
        requests: 600,
        ok: 120,
        rejected: 480,
        admittedTotal: 150,
        rejectedTotal: 600,
      },
      "chaos.gateway": {
        latency: [55, 70, 300],
        requests: chaos.requests,
        ok: chaos.ok,
        failed: chaos.requests - chaos.ok,
      },
    },
    server: { "no-cache": serverNoCache, "exact-cache": [1, 2, 3], streaming: null },
  };
}

const smokeId = "fixture-20260103T000000Z-ccccccc-smoke";
const dirtyId = "fixture-20260103T000000Z-ccccccc-dirty";
const specs: RunSpec[] = [
  // Batch A: three runs of one commit; client p95 overhead 8, 6 and 7 ms (median: the third).
  full(
    "fixture-20260101T000000Z-aaaaaaa",
    commitA,
    [53, 68, 90],
    { requests: 2400, ok: 2398 },
    [2, 4, 6],
  ),
  full(
    "fixture-20260101T010000Z-aaaaaaa",
    commitA,
    [53, 66, 90],
    { requests: 2400, ok: 2400 },
    [2, 4, 6],
  ),
  full(
    "fixture-20260101T020000Z-aaaaaaa",
    commitA,
    [53, 67, 95],
    { requests: 2400, ok: 2399 },
    [2, 4, 6],
  ),
  // Batch B: one run missing both targets, without server-side metrics.
  full(
    "fixture-20260102T000000Z-bbbbbbb",
    commitB,
    [60, 80, 120],
    { requests: 1000, ok: 980 },
    null,
  ),
  // Never publishable.
  {
    ...full(smokeId, commitB, [1, 2, 3], { requests: 10, ok: 10 }, null),
    environment: {
      kind: "smoke",
      publishable: false,
      notPublishableReasons: ["smoke run (CI correctness check, never published)"],
    },
  },
  {
    ...full(dirtyId, commitB, [1, 2, 3], { requests: 10, ok: 10 }, null),
    environment: {
      git: { commit: commitB, dirty: true },
      publishable: false,
      notPublishableReasons: ["git working tree was dirty"],
    },
  },
];

for (const spec of specs) {
  const data = makeRun(spec);
  const dir = join(out, data.id);
  ensureDir(join(dir, FILES.k6Dir));
  writeJson(join(dir, FILES.environment), data.environment);
  writeJson(join(dir, FILES.run), data.run);
  writeJson(join(dir, FILES.config), data.config);
  if (data.serverMetrics) writeJson(join(dir, FILES.serverMetrics), data.serverMetrics);
  for (const [key, summary] of Object.entries(data.summaries)) {
    writeJson(join(dir, FILES.k6Dir, `${key}.json`), summary);
  }
  console.log(`wrote ${dir}`);
}
