import type { ChatChunk, ChatRequest } from "./chat.js";

/**
 * Anthropic-only data carried alongside a canonical request (ADR-0016, option 3).
 *
 * The key is a symbol on purpose: clients cannot send it (JSON has no symbols), it is never
 * serialised to non-Anthropic upstreams, and object spread keeps it. Features must treat it as
 * opaque, copy requests with spread (not `structuredClone`) and only mask canonical text in place.
 */
export const ANTHROPIC_EXTENSION: unique symbol = Symbol.for("switchyard.anthropic.extension");

/** Raw provider event attached to a canonical chunk on native (same-family) streams. */
export const NATIVE_EVENT: unique symbol = Symbol.for("switchyard.native.event");

export type JsonPath = readonly (string | number)[];

/** Where one canonical text came from in the Anthropic body, to write masked text back. */
export interface TextSlot {
  /** Path in the canonical request (e.g. `["messages", 2, "content", 0, "text"]`). */
  canonical: JsonPath;
  /** Path in the Anthropic body. */
  native: JsonPath;
  /** `text`: a string; `json`: tool-call arguments (canonical string ↔ native `input` object). */
  kind: "text" | "json";
  /** The canonical value as produced from the body (unchanged → original bytes kept). */
  original: string;
}

export interface AnthropicExtension {
  /** The client's Anthropic request body, as received. */
  body: Readonly<Record<string, unknown>>;
  slots: readonly TextSlot[];
  /** `anthropic-beta` request header, forwarded on the same-family path only. */
  beta?: string | undefined;
}

export interface NativeEvent {
  /** SSE event name (equals `data.type` for Anthropic). */
  type: string;
  /** Raw `data` payload. */
  data: string;
}

type WithExtension = { [ANTHROPIC_EXTENSION]?: AnthropicExtension };
type WithNative = { [NATIVE_EVENT]?: NativeEvent };

export function withAnthropicExtension(
  request: ChatRequest,
  extension: AnthropicExtension,
): ChatRequest {
  return Object.assign({ ...request }, { [ANTHROPIC_EXTENSION]: extension });
}

export function anthropicExtensionOf(request: ChatRequest): AnthropicExtension | undefined {
  return (request as WithExtension)[ANTHROPIC_EXTENSION];
}

export function withNativeEvent(chunk: ChatChunk, event: NativeEvent): ChatChunk {
  return Object.assign(chunk, { [NATIVE_EVENT]: event });
}

export function nativeEventOf(chunk: ChatChunk): NativeEvent | undefined {
  return (chunk as WithNative)[NATIVE_EVENT];
}
