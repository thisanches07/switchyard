// Command-line arguments of `pnpm bench` (spec 012, AC-2).
import { SCENARIOS, type ScenarioName } from "./config.ts";

export interface BenchArgs {
  scenarios: ScenarioName[];
  smoke: boolean;
  /** Leave the stack running after the run (debugging). */
  keep: boolean;
}

const USAGE = `usage: pnpm bench [-- --scenario <name>[,<name>]] [--smoke] [--keep]
scenarios: ${SCENARIOS.join(", ")}`;

export function parseArgs(argv: readonly string[]): BenchArgs {
  const chosen = new Set<ScenarioName>();
  let smoke = false;
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue; // `pnpm bench -- --smoke` may forward the separator
    if (arg === "--smoke") smoke = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--scenario" || arg.startsWith("--scenario=")) {
      const value = arg === "--scenario" ? argv[++i] : arg.slice("--scenario=".length);
      if (!value) throw new Error(`--scenario needs a name\n${USAGE}`);
      for (const name of value.split(",").map((n) => n.trim())) {
        if (!(SCENARIOS as readonly string[]).includes(name)) {
          throw new Error(`unknown scenario "${name}"\n${USAGE}`);
        }
        chosen.add(name as ScenarioName);
      }
    } else {
      throw new Error(`unknown argument "${arg}"\n${USAGE}`);
    }
  }
  const scenarios = chosen.size === 0 ? [...SCENARIOS] : SCENARIOS.filter((s) => chosen.has(s));
  return { scenarios, smoke, keep };
}
