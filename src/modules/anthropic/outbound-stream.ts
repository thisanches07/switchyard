/**
 * Anthropic SSE events → `chat.completion.chunk`s (spec 014, AC-10/AC-12). Stateful but pure:
 * no I/O, one translator per stream.
 *
 * The `message_start` role chunk is held back until the first client-visible output (text or a
 * tool call), so thinking blocks and pings never cause headers to be sent: an `error` event during
 * thinking still fails before the first byte and stays retryable (AC-12, ADR-0008).
 */
import type { ChatChunk, Usage } from "../../core/chat.js";
import { mapStopReason, toOpenAiUsage } from "./outbound-response.js";
import { errorFromEvent } from "./upstream-errors.js";

export interface StreamTranslator {
  /** Chunks produced by one parsed event; throws `GatewayError` on an `error` event. */
  next(event: Record<string, unknown>): ChatChunk[];
  /** True once `message_stop` was seen. */
  readonly done: boolean;
  /** Usage so far (cumulative), or undefined if upstream reported none. */
  usage(): Usage | undefined;
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

export function createStreamTranslator(provider: string, created: number): StreamTranslator {
  let base: Rec = { id: "", object: "chat.completion.chunk", created, model: "" };
  let rolePending = true;
  let finished = false;
  let done = false;
  let toolCount = 0;
  const reported: Partial<Record<(typeof USAGE_FIELDS)[number], number>> = {};
  /** Anthropic block index → OpenAI tool-call index (text blocks map to "text"). */
  const blocks = new Map<number, number | "text">();

  const chunk = (delta: Rec, finishReason: string | null = null): ChatChunk => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  /** Emits a visible chunk, preceded by the deferred role chunk the first time. */
  const visible = (delta: Rec, finishReason: string | null = null): ChatChunk[] => {
    const out: ChatChunk[] = [];
    if (rolePending) {
      rolePending = false;
      out.push(chunk({ role: "assistant", content: "" }));
    }
    out.push(chunk(delta, finishReason));
    return out;
  };

  const absorbUsage = (usage: unknown) => {
    if (!isRecord(usage)) return;
    for (const field of USAGE_FIELDS) {
      const value = num(usage[field]);
      if (value !== undefined) reported[field] = value;
    }
  };

  const usage = (): Usage | undefined => {
    if (Object.keys(reported).length === 0) return undefined;
    const cacheRead = reported.cache_read_input_tokens ?? 0;
    return {
      inputTokens:
        (reported.input_tokens ?? 0) + (reported.cache_creation_input_tokens ?? 0) + cacheRead,
      outputTokens: reported.output_tokens ?? 0,
      cachedInputTokens: cacheRead,
    };
  };

  return {
    get done() {
      return done;
    },
    usage,

    next(event) {
      const index = num(event.index) ?? -1;
      switch (event.type) {
        case "message_start": {
          const message = isRecord(event.message) ? event.message : {};
          base = {
            ...base,
            id: typeof message.id === "string" ? message.id : "",
            model: typeof message.model === "string" ? message.model : "",
          };
          absorbUsage(message.usage);
          return [];
        }
        case "content_block_start": {
          const block = isRecord(event.content_block) ? event.content_block : {};
          if (block.type === "text") {
            blocks.set(index, "text");
            return typeof block.text === "string" && block.text.length > 0
              ? visible({ content: block.text })
              : [];
          }
          if (block.type === "tool_use") {
            const toolIndex = toolCount++;
            blocks.set(index, toolIndex);
            return visible({
              tool_calls: [
                {
                  index: toolIndex,
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: "" },
                },
              ],
            });
          }
          return []; // thinking, redacted_thinking, server tools: not exposed (ADR-0016)
        }
        case "content_block_delta": {
          const delta = isRecord(event.delta) ? event.delta : {};
          const target = blocks.get(index);
          if (delta.type === "text_delta" && target === "text" && typeof delta.text === "string") {
            return delta.text.length > 0 ? visible({ content: delta.text }) : [];
          }
          if (
            delta.type === "input_json_delta" &&
            typeof target === "number" &&
            typeof delta.partial_json === "string" &&
            delta.partial_json.length > 0
          ) {
            return visible({
              tool_calls: [{ index: target, function: { arguments: delta.partial_json } }],
            });
          }
          return []; // thinking_delta, signature_delta, citations…
        }
        case "message_delta": {
          absorbUsage(event.usage);
          if (finished) return [];
          finished = true;
          const delta = isRecord(event.delta) ? event.delta : {};
          return visible({}, mapStopReason(delta.stop_reason));
        }
        case "message_stop": {
          done = true;
          const total = usage();
          return total ? [{ ...base, choices: [], usage: toOpenAiUsage(total) }] : [];
        }
        case "error":
          throw errorFromEvent(provider, event);
        default:
          return []; // ping, content_block_stop and event types added later
      }
    },
  };
}
