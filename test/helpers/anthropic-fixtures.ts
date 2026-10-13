import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../fixtures/anthropic");

/** Raw text of a fixture in `test/fixtures/anthropic` (shapes from the Anthropic docs). */
export const fixtureText = (name: string): string => readFileSync(resolve(dir, name), "utf8");

/** Parsed `data` payloads of an `.sse` fixture, in order. */
export const fixtureEvents = (name: string): Record<string, unknown>[] =>
  fixtureText(name)
    .split(/\n\n+/)
    .map((event) => event.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);

export const fixtureJson = <T = Record<string, unknown>>(name: string): T =>
  JSON.parse(fixtureText(name)) as T;
