/**
 * Canonical `chat.completion` → Anthropic `message` for the cross-family `/v1/messages` path
 * (spec 014, AC-8). Pure.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { upstreamError } from "../../core/errors.js";

export interface StopInfo {
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal";
  stop_sequence: string | null;
}

const completionSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.unknown().optional(),
          tool_calls: z
            .array(
              z.looseObject({
                id: z.string().optional(),
                function: z.looseObject({ name: z.string(), arguments: z.string().optional() }),
              }),
            )
            .optional()
            .nullable(),
        }),
        finish_reason: z.string().nullable().optional(),
        /** Non-standard, reported by vLLM: the stop string that ended generation. */
        stop_reason: z.unknown().optional(),
      }),
    )
    .min(1),
  usage: z
    .looseObject({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .optional()
    .catch(undefined),
});

/** `msg_` + 24 hex characters, like Anthropic message ids. */
export const newMessageId = () => `msg_${randomBytes(12).toString("hex")}`;

export function mapFinishReason(
  finish: unknown,
  matched: unknown,
  stopSequences: readonly string[],
): StopInfo {
  switch (finish) {
    case "length":
      return { stop_reason: "max_tokens", stop_sequence: null };
    case "tool_calls":
    case "function_call":
      return { stop_reason: "tool_use", stop_sequence: null };
    case "content_filter":
      return { stop_reason: "refusal", stop_sequence: null };
    default:
      if (finish === "stop" && typeof matched === "string" && stopSequences.includes(matched)) {
        return { stop_reason: "stop_sequence", stop_sequence: matched };
      }
      return { stop_reason: "end_turn", stop_sequence: null };
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export interface ToMessageOptions {
  /** The model name the client sent (alias or provider/model). */
  model: string;
  provider: string;
  stopSequences?: readonly string[] | undefined;
}

export function toAnthropicMessage(
  completion: unknown,
  options: ToMessageOptions,
): Record<string, unknown> {
  const parsed = completionSchema.safeParse(completion);
  if (!parsed.success) throw upstreamError(options.provider);
  const [choice] = parsed.data.choices as [(typeof parsed.data.choices)[number]];

  const content: Record<string, unknown>[] = [];
  const text = textOf(choice.message.content);
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of choice.message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? newMessageId().replace("msg_", "toolu_"),
      name: call.function.name,
      input: parseInput(call.function.arguments, options.provider),
    });
  }

  const usage = parsed.data.usage;
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: options.model,
    content,
    ...mapFinishReason(choice.finish_reason, choice.stop_reason, options.stopSequences ?? []),
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      // Provider prompt-cache counts are not reported on the cross-family path (ADR-0016).
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function parseInput(args: string | undefined, provider: string): Record<string, unknown> {
  if (args === undefined || args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // reported below
  }
  // The provider produced unusable tool arguments: a provider failure, not the client's.
  throw upstreamError(provider);
}

/** Same-family responses are returned as upstream sent them, with the model the client asked for. */
export function withRequestedModel(message: unknown, model: string): unknown {
  if (typeof message !== "object" || message === null) return message;
  return { ...message, model };
}
