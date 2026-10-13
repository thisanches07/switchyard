import type { ChatChunk, ChatRequest, Usage } from "../../core/chat.js";

/** Usage reported in a streamed chunk (`usage` with prompt/completion token counts), if any. */
export function usageFromChunk(chunk: ChatChunk): Usage | undefined {
  const usage = chunk.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const { prompt_tokens: input, completion_tokens: output } = usage as Record<string, unknown>;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { inputTokens: input, outputTokens: output };
}

/**
 * Applies spec 003 AC-7: the gateway always asks providers for usage, but only clients
 * that asked for it themselves see it. Returns undefined when the chunk must be dropped.
 */
export function forwardChunk(chunk: ChatChunk, clientWantsUsage: boolean): ChatChunk | undefined {
  if (clientWantsUsage || !("usage" in chunk)) return chunk;
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const { usage: _usage, ...rest } = chunk;
  return rest;
}

/** Concatenated `delta.content` of all choices in a chunk (used only for counting). */
export function deltaText(chunk: ChatChunk): string {
  if (!Array.isArray(chunk.choices)) return "";
  let text = "";
  for (const choice of chunk.choices as unknown[]) {
    const delta = (choice as { delta?: { content?: unknown } } | null)?.delta;
    if (typeof delta?.content === "string") text += delta.content;
  }
  return text;
}

/** Characters of string message contents (used only for counting). */
export function messageChars(request: ChatRequest): number {
  return request.messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
}

/** Rough token estimate when a provider reports no usage: about four characters per token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
