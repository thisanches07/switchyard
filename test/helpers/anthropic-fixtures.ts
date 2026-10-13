import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../fixtures/anthropic");

/** Raw text of a fixture in `test/fixtures/anthropic` (shapes from the Anthropic docs). */
export const fixtureText = (name: string): string => readFileSync(resolve(dir, name), "utf8");

export const fixtureJson = <T = Record<string, unknown>>(name: string): T =>
  JSON.parse(fixtureText(name)) as T;
