// `pnpm bench:report [--check]` (spec 012, AC-6): regenerates the benchmark tables of
// docs/benchmarks.md and README.md from the committed run folders in bench/results/.
// --check exits 1 when a committed table differs from what would be generated.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/config.ts";
import { publishedFiles } from "./lib/publish.ts";

const check = process.argv.includes("--check");
const stale: string[] = [];

for (const file of publishedFiles(ROOT)) {
  if (file.current === file.expected) continue;
  if (check) stale.push(file.path);
  else {
    writeFileSync(join(ROOT, file.path), file.expected);
    console.log(`updated ${file.path}`);
  }
}

if (stale.length > 0) {
  console.error(
    `Benchmark tables are out of date in ${stale.join(", ")}: run \`pnpm bench:report\` and commit the result.`,
  );
  process.exit(1);
}
if (check) console.log("Benchmark tables match bench/results/.");
