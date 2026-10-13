/**
 * Conversions between `chat.completion` bodies and `chat.completion.chunk` streams (spec 009):
 * a streamed miss is assembled into the body that is stored (AC-4), and a stored body is
 * re-chunked when a hit is asked for as a stream (AC-7). Pure; the two are inverses for message
 * content, refusal, tool calls, finish reasons and usage.
 */
import type { ChatChunk, Usage } from "../../core/chat.js";

const CACHEABLE_FINISH = new Set(["stop", "length", "tool_calls"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A completion worth storing: at least one choice, every one finished normally (AC-4). */
export function cacheableBody(
  body: unknown,
): body is Record<string, unknown> & { choices: unknown[] } {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) return false;
  return body.choices.every(
    (choice) =>
      isRecord(choice) &&
      typeof choice.finish_reason === "string" &&
      CACHEABLE_FINISH.has(choice.finish_reason),
  );
}

interface ToolCallState {
  id?: unknown;
  type?: unknown;
  name: string;
  arguments: string;
  hasName: boolean;
}

interface ChoiceState {
  role: string;
  content: string | null;
  refusal: string | null;
  toolCalls: Map<number, ToolCallState>;
  finishReason: unknown;
}

const HEADER_FIELDS = ["id", "created", "model", "system_fingerprint"] as const;

/** The `chat.completion` a stream amounts to; undefined when it carried no choice. */
export function assembleCompletion(
  chunks: readonly ChatChunk[],
): Record<string, unknown> | undefined {
  const header: Record<string, unknown> = {};
  const choices = new Map<number, ChoiceState>();
  let usage: unknown;

  for (const chunk of chunks) {
    for (const field of HEADER_FIELDS) {
      if (header[field] === undefined && chunk[field] !== undefined && chunk[field] !== null) {
        header[field] = chunk[field];
      }
    }
    if (isRecord(chunk.usage)) usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) continue;
    for (const raw of chunk.choices as unknown[]) {
      if (!isRecord(raw)) continue;
      const index = typeof raw.index === "number" ? raw.index : 0;
      let state = choices.get(index);
      if (!state) {
        state = {
          role: "assistant",
          content: null,
          refusal: null,
          toolCalls: new Map(),
          finishReason: null,
        };
        choices.set(index, state);
      }
      if (raw.finish_reason !== undefined && raw.finish_reason !== null) {
        state.finishReason = raw.finish_reason;
      }
      if (isRecord(raw.delta)) applyDelta(state, raw.delta);
    }
  }
  if (choices.size === 0) return undefined;

  const body: Record<string, unknown> = {
    id: header.id,
    object: "chat.completion",
    created: header.created,
    model: header.model,
    ...(header.system_fingerprint !== undefined && {
      system_fingerprint: header.system_fingerprint,
    }),
    choices: [...choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, state]) => ({
        index,
        message: messageOf(state),
        finish_reason: state.finishReason,
        logprobs: null,
      })),
  };
  if (usage !== undefined) body.usage = usage;
  return body;
}

function applyDelta(state: ChoiceState, delta: Record<string, unknown>): void {
  if (typeof delta.role === "string") state.role = delta.role;
  if (typeof delta.content === "string") state.content = (state.content ?? "") + delta.content;
  if (typeof delta.refusal === "string") state.refusal = (state.refusal ?? "") + delta.refusal;
  if (!Array.isArray(delta.tool_calls)) return;
  for (const call of delta.tool_calls as unknown[]) {
    if (!isRecord(call)) continue;
    const index = typeof call.index === "number" ? call.index : state.toolCalls.size;
    let tool = state.toolCalls.get(index);
    if (!tool) {
      tool = { name: "", arguments: "", hasName: false };
      state.toolCalls.set(index, tool);
    }
    if (call.id !== undefined) tool.id = call.id;
    if (call.type !== undefined) tool.type = call.type;
    const fn = isRecord(call.function) ? call.function : {};
    if (typeof fn.name === "string") {
      tool.name += fn.name;
      tool.hasName = true;
    }
    if (typeof fn.arguments === "string") tool.arguments += fn.arguments;
  }
}

function messageOf(state: ChoiceState): Record<string, unknown> {
  const message: Record<string, unknown> = { role: state.role, content: state.content };
  if (state.refusal !== null) message.refusal = state.refusal;
  if (state.toolCalls.size > 0) {
    message.tool_calls = [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tool]) => ({
        ...(tool.id !== undefined && { id: tool.id }),
        ...(tool.type !== undefined && { type: tool.type }),
        function: { ...(tool.hasName && { name: tool.name }), arguments: tool.arguments },
      }));
  }
  return message;
}

/**
 * The stream of a stored completion: per choice one delta with the whole message and one with its
 * finish reason, then a usage-only chunk (`choices: []`). The usage chunk is the body's `usage`,
 * else built from `usage`; the encoder drops it unless the client asked for it (spec 003 AC-7).
 */
export function rechunk(body: Record<string, unknown>, usage: Usage): ChatChunk[] {
  const header: Record<string, unknown> = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
    ...(body.system_fingerprint !== undefined && { system_fingerprint: body.system_fingerprint }),
  };
  const chunks: ChatChunk[] = [];
  const choices = Array.isArray(body.choices) ? (body.choices as unknown[]) : [];
  choices.forEach((raw, position) => {
    if (!isRecord(raw)) return;
    const index = typeof raw.index === "number" ? raw.index : position;
    const message = isRecord(raw.message) ? raw.message : {};
    chunks.push({
      ...header,
      choices: [{ index, delta: deltaOf(message), finish_reason: null, logprobs: null }],
    });
    chunks.push({
      ...header,
      choices: [{ index, delta: {}, finish_reason: raw.finish_reason ?? null, logprobs: null }],
    });
  });
  const reported = isRecord(body.usage)
    ? body.usage
    : {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      };
  chunks.push({ ...header, choices: [], usage: reported });
  return chunks;
}

function deltaOf(message: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {
    role: typeof message.role === "string" ? message.role : "assistant",
  };
  if (typeof message.content === "string" || message.content === null) {
    delta.content = message.content;
  }
  if (typeof message.refusal === "string") delta.refusal = message.refusal;
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = (message.tool_calls as unknown[]).map((call, index) =>
      isRecord(call) ? { index, ...call } : call,
    );
  }
  return delta;
}
