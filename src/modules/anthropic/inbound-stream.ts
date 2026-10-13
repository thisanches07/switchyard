/**
 * Anthropic SSE for `/v1/messages` streams (spec 014, AC-11/AC-12).
 *
 * Same-family: chunks carry the raw upstream event (`NATIVE_EVENT`), forwarded unchanged except
 * `message.model` in `message_start`. Cross-family: Anthropic events are synthesised from
 * canonical chunks. Either way there is no `[DONE]`, and a failure after the first byte becomes
 * one `event: error`.
 */
import { nativeEventOf } from "../../core/anthropic.js";
import type { ChatChunk, Usage } from "../../core/chat.js";
import type { GatewayError } from "../../core/errors.js";
import type { StreamEncoder } from "../proxy/stream.js";
import { anthropicErrorType } from "./inbound-errors.js";
import { mapFinishReason, newMessageId, type StopInfo } from "./inbound-response.js";

export interface AnthropicEncoderOptions {
  /** The model name the client sent. */
  model: string;
  stopSequences?: readonly string[] | undefined;
  /** Input estimate for `message_start` (the real count follows in `message_delta`). */
  inputTokens?: number | undefined;
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const event = (type: string, data: Rec) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export function createAnthropicEncoder(options: AnthropicEncoderOptions): StreamEncoder {
  let native = false;
  let started = false;
  let nextIndex = 0;
  let open: { index: number; kind: "text" | "tool"; tool?: number } | undefined;
  const toolBlocks = new Map<number, number>();
  let stop: StopInfo = { stop_reason: "end_turn", stop_sequence: null };

  const forward = (type: string, data: string): string => {
    if (type !== "message_start") return `event: ${type}\ndata: ${data}\n\n`;
    try {
      const parsed = JSON.parse(data) as Rec;
      if (isRecord(parsed.message)) parsed.message = { ...parsed.message, model: options.model };
      return `event: ${type}\ndata: ${JSON.stringify(parsed)}\n\n`;
    } catch {
      return `event: ${type}\ndata: ${data}\n\n`;
    }
  };

  const start = (out: string[]) => {
    if (started) return;
    started = true;
    out.push(
      event("message_start", {
        message: {
          id: newMessageId(),
          type: "message",
          role: "assistant",
          model: options.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: options.inputTokens ?? 0, output_tokens: 0 },
        },
      }),
    );
  };

  const close = (out: string[]) => {
    if (!open) return;
    out.push(event("content_block_stop", { index: open.index }));
    open = undefined;
  };

  const openBlock = (out: string[], kind: "text" | "tool", block: Rec, tool?: number) => {
    close(out);
    const index = nextIndex++;
    open = { index, kind, ...(tool !== undefined && { tool }) };
    out.push(event("content_block_start", { index, content_block: block }));
    return index;
  };

  return {
    chunk(chunk: ChatChunk): string[] {
      const raw = nativeEventOf(chunk);
      if (raw) {
        native = true;
        return [forward(raw.type, raw.data)];
      }
      if (native) return []; // canonical companions of native events
      const out: string[] = [];
      start(out);
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : undefined;
      const delta = isRecord(choice?.delta) ? choice.delta : {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        const index =
          open?.kind === "text" ? open.index : openBlock(out, "text", { type: "text", text: "" });
        out.push(
          event("content_block_delta", {
            index,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!isRecord(call)) continue;
        const tool = typeof call.index === "number" ? call.index : 0;
        const fn = isRecord(call.function) ? call.function : {};
        let index = toolBlocks.get(tool);
        if (index === undefined) {
          index = openBlock(
            out,
            "tool",
            { type: "tool_use", id: call.id ?? newMessageId(), name: fn.name, input: {} },
            tool,
          );
          toolBlocks.set(tool, index);
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          out.push(
            event("content_block_delta", {
              index,
              delta: { type: "input_json_delta", partial_json: fn.arguments },
            }),
          );
        }
      }
      if (choice?.finish_reason) {
        stop = mapFinishReason(
          choice.finish_reason,
          choice.stop_reason,
          options.stopSequences ?? [],
        );
      }
      return out;
    },

    end(usage: Usage): string[] {
      if (native) return []; // upstream message_delta and message_stop were forwarded
      const out: string[] = [];
      start(out);
      close(out);
      out.push(
        event("message_delta", {
          delta: stop,
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        }),
      );
      out.push(event("message_stop", {}));
      return out;
    },

    error(error: GatewayError): string {
      return event("error", {
        error: { type: anthropicErrorType(error.status), message: error.message },
      });
    },
  };
}
