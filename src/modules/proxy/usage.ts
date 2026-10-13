import type { ChatChunk, ChatRequest, Usage } from "../../core/chat.js";

/** Usage reported in a streamed chunk (`usage` with prompt/completion token counts), if any. */
export function usageFromChunk(chunk: ChatChunk): Usage | undefined {
  const usage = chunk.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const {
    prompt_tokens: input,
    completion_tokens: output,
    prompt_tokens_details: details,
  } = usage as Record<string, unknown>;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const cached =
    typeof details === "object" && details !== null
      ? (details as { cached_tokens?: unknown }).cached_tokens
      : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
  };
}

/**
 * Usage of a non-streaming chat completion whose provider reported none (spec 006): the
 * spec 003 estimate of the input messages and of the returned message contents.
 */
export function estimateChatUsage(request: ChatRequest, body: unknown): Usage {
  let outputChars = 0;
  const choices = typeof body === "object" && body !== null ? Reflect.get(body, "choices") : [];
  if (Array.isArray(choices)) {
    for (const choice of choices as unknown[]) {
      const content = (choice as { message?: { content?: unknown } } | null)?.message?.content;
      if (typeof content === "string") outputChars += content.length;
    }
  }
  return {
    inputTokens: estimateTokens(messageChars(request)),
    outputTokens: estimateTokens(outputChars),
  };
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
