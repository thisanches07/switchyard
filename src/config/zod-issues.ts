import type { z } from "zod";
import type { ConfigIssue } from "./errors.js";

/** Converts a Zod path like `["aliases", "fast", "candidates", 1]` into `aliases.fast.candidates[1]`. */
export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, key) => {
    if (typeof key === "number") return `${acc}[${key}]`;
    const name = String(key);
    return acc ? `${acc}.${name}` : name;
  }, "");
}

export function toConfigIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}
