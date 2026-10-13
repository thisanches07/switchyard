import type { z } from "zod";
import { formatPath } from "../config/zod-issues.js";
import { invalidRequest } from "../core/errors.js";

/** Validates input with Zod (ADR-0014); the first issue becomes a 400 naming the field. */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? formatPath(issue.path) : "";
    throw invalidRequest(where ? `${where}: ${issue?.message}` : "Invalid request");
  }
  return result.data;
}
