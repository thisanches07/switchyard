/**
 * Anthropic Messages request → canonical (OpenAI-shaped) request (spec 014, AC-7/AC-8). Pure.
 *
 * The canonical request holds only what every feature reads (roles, text, tool calls and
 * results, limits). The client's body is attached unchanged as the Anthropic extension, with a
 * slot per canonical text so the same-family path can write masked text back (ADR-0016).
 */
import { type JsonPath, type TextSlot, withAnthropicExtension } from "../../core/anthropic.js";
import type { ChatMessage, ChatRequest } from "../../core/chat.js";
import type { MessagesRequest } from "./schema.js";

export interface InboundRequest {
  /** Canonical request with the Anthropic extension attached. */
  request: ChatRequest;
  /**
   * Fields a non-Anthropic provider cannot serve (ADR-0016 table): the route answers 400 on the
   * cross-family path and ignores them on the same-family path.
   */
  blockers: string[];
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Builder {
  messages: ChatMessage[];
  slots: TextSlot[];
  blockers: string[];
}

export function fromAnthropicRequest(
  body: MessagesRequest,
  options: { beta?: string | undefined } = {},
): InboundRequest {
  const b: Builder = { messages: [], slots: [], blockers: [] };

  if (typeof body.system === "string") {
    pushText(b, "system", body.system, ["system"]);
  } else if (Array.isArray(body.system)) {
    body.system.forEach((block, j) => {
      pushText(b, "system", block.text, ["system", j, "text"]);
    });
  }

  body.messages.forEach((message, i) => {
    if (message.role === "assistant") assistant(b, message.content, i);
    else user(b, message.content, i);
  });

  const request: ChatRequest = {
    model: body.model,
    messages: b.messages,
    max_tokens: body.max_tokens,
  };
  if (body.stop_sequences) request.stop = body.stop_sequences;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  if (body.top_p !== undefined) request.top_p = body.top_p;
  // Passed through: a provider that rejects it answers with its own 400 (ADR-0016).
  if (body.top_k !== undefined) request.top_k = body.top_k;
  const userId = body.metadata?.user_id;
  if (typeof userId === "string") request.user = userId;

  if (body.tools) {
    const tools: unknown[] = [];
    body.tools.forEach((tool, i) => {
      if (tool.type !== undefined && tool.type !== "custom") {
        b.blockers.push(`tools[${i}] (server tool "${tool.type}")`);
        return;
      }
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" && { description: tool.description }),
          parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object" },
        },
      });
    });
    request.tools = tools;
  }
  translateToolChoice(body.tool_choice, request);

  if (body.stream === true) {
    request.stream = true;
    // Usage is needed for the synthesised message_delta on the cross-family path.
    request.stream_options = { include_usage: true };
  }

  return {
    request: withAnthropicExtension(request, {
      body,
      slots: b.slots,
      beta: options.beta,
    }),
    blockers: b.blockers,
  };
}

function pushText(b: Builder, role: string, text: string, native: JsonPath): void {
  const index = b.messages.push({ role, content: text }) - 1;
  b.slots.push({ canonical: ["messages", index, "content"], native, kind: "text", original: text });
}

/** Text parts of one canonical message: a single part collapses to a string. */
function textContent(
  b: Builder,
  index: number,
  parts: { text: string; native: JsonPath }[],
): string | Rec[] {
  if (parts.length === 1) {
    const [only] = parts as [{ text: string; native: JsonPath }];
    b.slots.push({
      canonical: ["messages", index, "content"],
      native: only.native,
      kind: "text",
      original: only.text,
    });
    return only.text;
  }
  return parts.map((part, k) => {
    b.slots.push({
      canonical: ["messages", index, "content", k, "text"],
      native: part.native,
      kind: "text",
      original: part.text,
    });
    return { type: "text", text: part.text };
  });
}

function assistant(b: Builder, content: string | Rec[], i: number): void {
  if (typeof content === "string") {
    pushText(b, "assistant", content, ["messages", i, "content"]);
    return;
  }
  const index = b.messages.length;
  const texts: { text: string; native: JsonPath }[] = [];
  const toolCalls: Rec[] = [];
  content.forEach((block, j) => {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push({ text: block.text, native: ["messages", i, "content", j, "text"] });
    } else if (block.type === "tool_use") {
      const args = JSON.stringify(block.input ?? {});
      b.slots.push({
        canonical: ["messages", index, "tool_calls", toolCalls.length, "function", "arguments"],
        native: ["messages", i, "content", j, "input"],
        kind: "json",
        original: args,
      });
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: args },
      });
    }
    // thinking / redacted_thinking and server-tool blocks have no canonical form: dropped
    // cross-family, re-emitted from the extension same-family (ADR-0016).
  });
  if (texts.length === 0 && toolCalls.length === 0) return;
  const message: ChatMessage = { role: "assistant", content: null };
  b.messages.push(message);
  if (texts.length > 0) message.content = textContent(b, index, texts);
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
}

function user(b: Builder, content: string | Rec[], i: number): void {
  if (typeof content === "string") {
    pushText(b, "user", content, ["messages", i, "content"]);
    return;
  }
  const parts: Rec[] = [];
  const texts: { text: string; native: JsonPath; part: number }[] = [];
  content.forEach((block, j) => {
    const at = `messages[${i}].content[${j}]`;
    if (block.type === "tool_result") {
      toolResult(b, block, i, j);
    } else if (block.type === "text" && typeof block.text === "string") {
      texts.push({
        text: block.text,
        native: ["messages", i, "content", j, "text"],
        part: parts.length,
      });
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const url = imageUrl(block.source);
      if (url) parts.push({ type: "image_url", image_url: { url } });
      else b.blockers.push(`${at}.source (only base64 and url image sources)`);
    } else {
      b.blockers.push(`${at} ("${block.type}" blocks)`);
    }
  });
  if (parts.length === 0) return;
  const index = b.messages.length;
  if (parts.length === 1 && texts.length === 1) {
    b.messages.push({ role: "user", content: textContent(b, index, texts) });
    return;
  }
  for (const text of texts) {
    b.slots.push({
      canonical: ["messages", index, "content", text.part, "text"],
      native: text.native,
      kind: "text",
      original: text.text,
    });
  }
  b.messages.push({ role: "user", content: parts });
}

function toolResult(b: Builder, block: Rec, i: number, j: number): void {
  const index = b.messages.length;
  const native: JsonPath = ["messages", i, "content", j, "content"];
  const message: ChatMessage = { role: "tool", tool_call_id: block.tool_use_id, content: "" };
  b.messages.push(message);
  const content = block.content;
  if (typeof content === "string") {
    message.content = content;
    b.slots.push({
      canonical: ["messages", index, "content"],
      native,
      kind: "text",
      original: content,
    });
    return;
  }
  if (!Array.isArray(content)) return;
  const parts: Rec[] = [];
  content.forEach((inner: unknown, k) => {
    if (isRecord(inner) && inner.type === "text" && typeof inner.text === "string") {
      b.slots.push({
        canonical: ["messages", index, "content", parts.length, "text"],
        native: [...native, k, "text"],
        kind: "text",
        original: inner.text,
      });
      parts.push({ type: "text", text: inner.text });
    } else {
      b.blockers.push(`messages[${i}].content[${j}].content[${k}] (only text inside tool_result)`);
    }
  });
  message.content = parts;
}

function imageUrl(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  if (source.type === "base64" && typeof source.data === "string") {
    return `data:${String(source.media_type)};base64,${source.data}`;
  }
  if (source.type === "url" && typeof source.url === "string") return source.url;
  return undefined;
}

function translateToolChoice(choice: Rec | undefined, request: ChatRequest): void {
  if (!choice) return;
  if (choice.type === "auto") request.tool_choice = "auto";
  else if (choice.type === "none") request.tool_choice = "none";
  else if (choice.type === "any") request.tool_choice = "required";
  else if (choice.type === "tool") {
    request.tool_choice = { type: "function", function: { name: choice.name } };
  }
  if (choice.disable_parallel_tool_use === true) request.parallel_tool_calls = false;
}
