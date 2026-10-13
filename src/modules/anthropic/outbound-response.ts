/**
 * Anthropic `message` → OpenAI `chat.completion` (spec 014, AC-3/AC-4). Pure.
 * Thinking, redacted thinking and server-tool blocks are dropped (ADR-0016).
 */
import { z } from "zod";
import type { Usage } from "../../core/chat.js";

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionBody {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: FinishReason;
    logprobs: null;
  }[];
  usage?: OpenAiUsage;
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

const block = z.looseObject({ type: z.string() });

export const anthropicMessageSchema = z.looseObject({
  id: z.string(),
  model: z.string(),
  content: z.array(block),
  stop_reason: z.string().nullable().optional(),
  usage: z.unknown().optional(),
});

const usageSchema = z.looseObject({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().nullable().optional(),
  cache_read_input_tokens: z.number().nullable().optional(),
});

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export function mapStopReason(reason: unknown): FinishReason {
  return (typeof reason === "string" && STOP_REASONS[reason]) || "stop";
}

/** Canonical usage: input includes cache reads and writes; reads are also reported apart. */
export function usageFromAnthropic(usage: unknown): Usage | undefined {
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) return undefined;
  const u = parsed.data;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead,
    outputTokens: u.output_tokens,
    cachedInputTokens: cacheRead,
  };
}

export function toOpenAiUsage(usage: Usage): OpenAiUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
  };
}

export interface TranslatedCompletion {
  body: ChatCompletionBody;
  usage: Usage | undefined;
  responseModel: string;
}

/** Throws a ZodError when `message` is not an Anthropic message (the adapter maps it to 502). */
export function toChatCompletion(message: unknown, created: number): TranslatedCompletion {
  const parsed = anthropicMessageSchema.parse(message);
  let text: string | null = null;
  const toolCalls: ToolCall[] = [];
  for (const item of parsed.content) {
    if (item.type === "text" && typeof item.text === "string") {
      text = (text ?? "") + item.text;
    } else if (item.type === "tool_use") {
      toolCalls.push({
        id: String(item.id),
        type: "function",
        function: { name: String(item.name), arguments: JSON.stringify(item.input ?? {}) },
      });
    }
  }
  const usage = usageFromAnthropic(parsed.usage);
  const body: ChatCompletionBody = {
    id: parsed.id,
    object: "chat.completion",
    created,
    model: parsed.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text ?? (toolCalls.length > 0 ? null : ""),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: mapStopReason(parsed.stop_reason),
        logprobs: null,
      },
    ],
    ...(usage && { usage: toOpenAiUsage(usage) }),
  };
  return { body, usage, responseModel: parsed.model };
}
