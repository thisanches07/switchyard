/**
 * Canonical (OpenAI-shaped) chat request → Anthropic Messages request (spec 014, AC-2/AC-3).
 * Pure: throws `GatewayError` 400s for what Anthropic cannot honour (ADR-0016 table).
 */
import type { ChatMessage, ChatRequest } from "../../core/chat.js";
import { invalidRequest, invalidToolArguments, unsupportedParameter } from "../../core/errors.js";

export interface OutboundOptions {
  /** `max_tokens` when the request sets neither `max_completion_tokens` nor `max_tokens`. */
  defaultMaxTokens: number;
}

export interface OutboundRequest {
  /** Anthropic body without `stream` (the adapter sets it). */
  body: Record<string, unknown>;
  /** Request fields dropped because Anthropic has no equivalent (span `switchyard.dropped_params`). */
  dropped: string[];
}

type Block = Record<string, unknown>;
interface Turn {
  role: "user" | "assistant";
  content: Block[];
}

/** Fields this module translates, rejects or deliberately ignores; anything else is dropped. */
const HANDLED = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "temperature",
  "top_p",
  "user",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "n",
  "logprobs",
  "top_logprobs",
  "response_format",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

export function toAnthropicRequest(
  request: ChatRequest,
  options: OutboundOptions,
): OutboundRequest {
  rejectUnsupported(request);

  const dropped = Object.keys(request).filter(
    (key) => !HANDLED.has(key) && request[key] !== undefined && request[key] !== null,
  );

  const { system, turns } = translateMessages(request.messages);
  const body: Record<string, unknown> = { model: request.model };
  if (system.length > 0) body.system = system.join("\n\n");
  body.messages = turns.map(collapse);
  body.max_tokens =
    positive(request.max_completion_tokens) ??
    positive(request.max_tokens) ??
    options.defaultMaxTokens;

  const stop = request.stop;
  if (typeof stop === "string") body.stop_sequences = [stop];
  else if (Array.isArray(stop)) body.stop_sequences = stop;
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  if (typeof request.user === "string") body.metadata = { user_id: request.user };

  if (Array.isArray(request.tools)) body.tools = request.tools.map(translateTool);
  const toolChoice = translateToolChoice(request.tool_choice, request.parallel_tool_calls);
  if (toolChoice) body.tool_choice = toolChoice;

  return { body, dropped };
}

function rejectUnsupported(request: ChatRequest): void {
  if (typeof request.n === "number" && request.n > 1) {
    throw unsupportedParameter("n", "only one choice (n = 1) is supported");
  }
  if (request.logprobs === true) throw unsupportedParameter("logprobs", "not available");
  if (request.top_logprobs !== undefined && request.top_logprobs !== null) {
    throw unsupportedParameter("top_logprobs", "not available");
  }
  const format = request.response_format;
  if (isRecord(format) && format.type !== "text") {
    throw unsupportedParameter("response_format", `type "${String(format.type)}" is not supported`);
  }
}

function translateMessages(messages: ChatMessage[]): { system: string[]; turns: Turn[] } {
  const system: string[] = [];
  const turns: Turn[] = [];
  const push = (role: Turn["role"], content: Block[]) => {
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content });
  };

  messages.forEach((message, i) => {
    const where = `messages[${i}]`;
    switch (message.role) {
      case "system":
      case "developer":
        system.push(textOf(message.content, where));
        return;
      case "user":
        push("user", userBlocks(message.content, where));
        return;
      case "assistant": {
        const blocks = assistantBlocks(message, where);
        if (blocks.length > 0) push("assistant", blocks);
        return;
      }
      case "tool":
        push("user", [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: toolResultContent(message.content, where),
          },
        ]);
        return;
      default:
        throw invalidRequest(
          `${where}.role "${message.role}" is not supported by Anthropic providers`,
        );
    }
  });
  return { system, turns };
}

/** A turn holding one plain text block is sent as a string, like the client would write it. */
function collapse(turn: Turn): { role: string; content: unknown } {
  const [only] = turn.content;
  if (turn.content.length === 1 && only?.type === "text" && Object.keys(only).length === 2) {
    return { role: turn.role, content: only.text };
  }
  return { role: turn.role, content: turn.content };
}

function textOf(content: unknown, where: string): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) throw invalidRequest(`${where}.content must be a string or array`);
  return content
    .map((part, j) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
      throw unsupportedParameter(`${where}.content[${j}].type`, "only text parts are allowed here");
    })
    .join("\n");
}

function userBlocks(content: unknown, where: string): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw invalidRequest(`${where}.content must be a string or array`);
  return content.map((part, j) => {
    const at = `${where}.content[${j}]`;
    if (!isRecord(part)) throw invalidRequest(`${at} must be an object`);
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url") return imageBlock(part.image_url, at);
    throw unsupportedParameter(`${at}.type`, `"${String(part.type)}" parts are not supported`);
  });
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function imageBlock(imageUrl: unknown, at: string): Block {
  const url = isRecord(imageUrl) ? imageUrl.url : imageUrl;
  if (typeof url === "string") {
    const data = DATA_URI.exec(url);
    if (data) {
      return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
    }
    if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  }
  throw unsupportedParameter(
    `${at}.image_url`,
    "only data: URIs (base64) and http(s) URLs are supported",
  );
}

function assistantBlocks(message: ChatMessage, where: string): Block[] {
  const blocks: Block[] = [];
  const text = textOf(message.content, where);
  if (text.length > 0) blocks.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  calls.forEach((call, j) => {
    const at = `${where}.tool_calls[${j}]`;
    const fn = isRecord(call) && isRecord(call.function) ? call.function : {};
    blocks.push({
      type: "tool_use",
      id: isRecord(call) ? call.id : undefined,
      name: fn.name,
      input: parseArguments(fn.arguments, at),
    });
  });
  return blocks;
}

function parseArguments(args: unknown, at: string): Record<string, unknown> {
  if (args === undefined || args === null || args === "") return {};
  let parsed: unknown;
  try {
    parsed = typeof args === "string" ? JSON.parse(args) : args;
  } catch {
    throw invalidToolArguments(`${at}.function.arguments is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw invalidToolArguments(`${at}.function.arguments must be a JSON object`);
  }
  return parsed;
}

function toolResultContent(content: unknown, where: string): unknown {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) throw invalidRequest(`${where}.content must be a string or array`);
  return content.map((part, j) => {
    if (isRecord(part) && part.type === "text") return { type: "text", text: part.text };
    throw unsupportedParameter(`${where}.content[${j}].type`, "tool results may only contain text");
  });
}

function translateTool(tool: unknown, i: number): Block {
  if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
    throw unsupportedParameter(`tools[${i}]`, "only function tools are supported");
  }
  const fn = tool.function;
  return {
    name: fn.name,
    ...(typeof fn.description === "string" && { description: fn.description }),
    input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
  };
}

function translateToolChoice(choice: unknown, parallel: unknown): Block | undefined {
  let result: Block | undefined;
  if (choice === "auto") result = { type: "auto" };
  else if (choice === "none") result = { type: "none" };
  else if (choice === "required") result = { type: "any" };
  else if (isRecord(choice) && isRecord(choice.function)) {
    result = { type: "tool", name: choice.function.name };
  } else if (choice !== undefined && choice !== null) {
    throw unsupportedParameter("tool_choice", "use auto, none, required or a function name");
  }
  if (parallel === false && result?.type !== "none") {
    result = { ...(result ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  return result;
}
