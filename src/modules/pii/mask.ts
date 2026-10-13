import type { ChatMessage, ChatRequest, EmbeddingsRequest } from "../../core/chat.js";
import type { PiiDetections, PiiType } from "../../core/pii.js";
import { highestPlaceholders, placeholder, type RestoreMap } from "./placeholder.js";
import type { Scanner } from "./scan.js";

/** Outcome of masking one request. `restore` must stay in the request's memory (ADR-0010). */
export interface MaskResult<T> {
  /** A new request with every detection replaced; the input is never mutated. */
  request: T;
  restore: RestoreMap;
  /** Occurrences per type (two copies of one value count 2). */
  detections: PiiDetections;
  /** True when part of the input could not be inspected (token-array embeddings input). */
  uninspected: boolean;
}

type TextKind = "text" | "json";
type TextVisitor = (text: string, kind: TextKind) => string;

/**
 * Per-request masker: the same exact string of the same type always gets the same placeholder;
 * numbers start after `reserved` (placeholders the client already wrote).
 */
function createMasker(scan: Scanner, reserved: Map<PiiType, number>) {
  const restore = new Map<string, string>();
  const byValue = new Map<string, string>();
  const counters = new Map(reserved);
  const detections: PiiDetections = {};

  function maskText(text: string): string {
    const found = scan(text);
    if (found.length === 0) return text;
    let out = "";
    let last = 0;
    for (const { type, start, end } of found) {
      const value = text.slice(start, end);
      const key = `${type}\u0000${value}`;
      let token = byValue.get(key);
      if (!token) {
        const n = (counters.get(type) ?? 0) + 1;
        counters.set(type, n);
        token = placeholder(type, n);
        byValue.set(key, token);
        restore.set(token, value);
      }
      detections[type] = (detections[type] ?? 0) + 1;
      out += text.slice(last, start) + token;
      last = end;
    }
    return out + text.slice(last);
  }

  /** Tool-call arguments: mask JSON string values when the text parses, else the raw text. */
  function maskJson(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return maskText(text);
    }
    let changed = false;
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        const masked = maskText(value);
        if (masked !== value) changed = true;
        return masked;
      }
      if (Array.isArray(value)) return value.map(walk);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      }
      return value;
    };
    const masked = walk(parsed);
    return changed ? JSON.stringify(masked) : text;
  }

  return {
    visit: ((text, kind) => (kind === "json" ? maskJson(text) : maskText(text))) as TextVisitor,
    restore: restore as RestoreMap,
    detections,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Applies `visit` to every inspected field of a chat request (spec 010 Concepts), in order:
 * each message's content (string or `type: "text"` parts), then its tool-call arguments.
 * Everything else (images, audio, files, tool definitions, names, parameters) is kept as is.
 */
function mapChatTexts(request: ChatRequest, visit: TextVisitor): ChatRequest {
  const messages = request.messages.map((message): ChatMessage => {
    const next: ChatMessage = { ...message };
    if (typeof message.content === "string") {
      next.content = visit(message.content, "text");
    } else if (Array.isArray(message.content)) {
      next.content = message.content.map((part: unknown) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string"
          ? { ...part, text: visit(part.text, "text") }
          : part,
      );
    }
    if (Array.isArray(message.tool_calls)) {
      next.tool_calls = message.tool_calls.map((call: unknown) => {
        if (!isRecord(call) || !isRecord(call.function)) return call;
        const args = call.function.arguments;
        if (typeof args !== "string") return call;
        return { ...call, function: { ...call.function, arguments: visit(args, "json") } };
      });
    }
    return next;
  });
  return { ...request, messages };
}

function collect(each: (visit: TextVisitor) => void): string[] {
  const texts: string[] = [];
  each((text) => {
    texts.push(text);
    return text;
  });
  return texts;
}

/** Masks the inspected fields of a chat request (spec 010, AC-7). */
export function maskChatRequest(request: ChatRequest, scan: Scanner): MaskResult<ChatRequest> {
  const reserved = highestPlaceholders(collect((visit) => mapChatTexts(request, visit)));
  const masker = createMasker(scan, reserved);
  const masked = mapChatTexts(request, masker.visit);
  return {
    request: masked,
    restore: masker.restore,
    detections: masker.detections,
    uninspected: false,
  };
}

/** Masks embeddings input when it is text; token arrays pass through uninspected. */
export function maskEmbeddingsRequest(
  request: EmbeddingsRequest,
  scan: Scanner,
): MaskResult<EmbeddingsRequest> {
  const { input } = request;
  const texts =
    typeof input === "string"
      ? [input]
      : Array.isArray(input) && input.every((item) => typeof item === "string")
        ? (input as string[])
        : undefined;
  if (!texts) {
    return { request, restore: new Map(), detections: {}, uninspected: true };
  }
  const masker = createMasker(scan, highestPlaceholders(texts));
  const masked = texts.map((text) => masker.visit(text, "text"));
  return {
    request: { ...request, input: typeof input === "string" ? masked[0] : masked },
    restore: masker.restore,
    detections: masker.detections,
    uninspected: false,
  };
}
