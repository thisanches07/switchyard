import type { ChatRequest } from "../../core/chat.js";
import { estimateTokens, messageChars } from "../proxy/usage.js";

function allowance(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Tokens reserved for a chat request (spec 005, AC-5): the input estimate plus the completion
 * allowance (`max_completion_tokens`, else `max_tokens`, else the configured reserve).
 */
export function estimateChatTokens(request: ChatRequest, completionReserve: number): number {
  const completion =
    allowance(request.max_completion_tokens) ?? allowance(request.max_tokens) ?? completionReserve;
  return estimateTokens(messageChars(request)) + completion;
}

/** Tokens reserved for an embeddings request: input only (no completion). */
export function estimateEmbeddingTokens(input: unknown): number {
  if (typeof input === "string") return estimateTokens(input.length);
  if (Array.isArray(input)) {
    if (input.every((item) => typeof item === "string")) {
      return estimateTokens((input as string[]).reduce((sum, text) => sum + text.length, 0));
    }
    // Pre-tokenised input: one id per token.
    return input.reduce<number>((sum, item) => sum + (Array.isArray(item) ? item.length : 1), 0);
  }
  return 1;
}
