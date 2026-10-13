import { z } from "zod";
import type { ChatRequest, EmbeddingsRequest } from "../../core/chat.js";
import { parseWith } from "../validation.js";

// Only what the gateway needs; every other field is kept and passed through (ADR-0003).
const chatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(z.looseObject({ role: z.string() })).min(1),
  stream: z.boolean().optional(),
});

const embeddingsRequestSchema = z.looseObject({
  model: z.string().min(1),
  // OpenAI accepts text, a list of texts, or pre-tokenised input.
  input: z.union([
    z.string(),
    z.array(z.string()).min(1),
    z.array(z.number()).min(1),
    z.array(z.array(z.number()).min(1)).min(1),
  ]),
  encoding_format: z.string().optional(),
});

export const parseChatRequest = (body: unknown): ChatRequest => parseWith(chatRequestSchema, body);

export const parseEmbeddingsRequest = (body: unknown): EmbeddingsRequest =>
  parseWith(embeddingsRequestSchema, body);
