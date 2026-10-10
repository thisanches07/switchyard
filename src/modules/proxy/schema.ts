import { z } from "zod";
import { formatPath } from "../../config/zod-issues.js";
import type { ChatRequest } from "../../core/chat.js";
import { invalidRequest } from "../../core/errors.js";

// Only what the gateway needs; every other field is kept and passed through (ADR-0003).
const chatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(z.looseObject({ role: z.string() })).min(1),
  stream: z.boolean().optional(),
});

export function parseChatRequest(body: unknown): ChatRequest {
  const result = chatRequestSchema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? formatPath(issue.path) : "";
    throw invalidRequest(where ? `${where}: ${issue?.message}` : "Invalid request body");
  }
  return result.data;
}
