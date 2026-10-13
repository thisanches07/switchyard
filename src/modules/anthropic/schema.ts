import { z } from "zod";
import { parseWith } from "../validation.js";

// Only what the gateway reads; every other field is kept and, on the same-family path, re-emitted.
const block = z.looseObject({ type: z.string() });
const textBlock = z.looseObject({ type: z.literal("text"), text: z.string() });

const messagesRequestSchema = z.looseObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(block)]),
      }),
    )
    .min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  stop_sequences: z.array(z.string()).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().nonnegative().optional(),
  tools: z.array(z.looseObject({ name: z.string(), type: z.string().optional() })).optional(),
  tool_choice: z.looseObject({ type: z.string() }).optional(),
  metadata: z.looseObject({}).optional(),
  stream: z.boolean().optional(),
});

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

/**
 * Validates a `/v1/messages` body (spec 014, AC-6) and returns the body **as received**: Zod's
 * output re-orders keys, and the same-family path must re-emit the client's bytes (AC-7).
 */
export function parseMessagesRequest(body: unknown): MessagesRequest {
  parseWith(messagesRequestSchema, body);
  return body as MessagesRequest;
}
