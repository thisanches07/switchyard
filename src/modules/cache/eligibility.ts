/**
 * Which cache layers a chat request may use (spec 009, AC-2 and AC-5). Pure.
 */
import type { ChatRequest } from "../../core/chat.js";
import { invalidCacheHeader } from "../../core/errors.js";

export const CACHE_HEADER = "x-switchyard-cache";

/** `default`: the rules below; `force`: exact cache whatever the temperature; `bypass`: no cache. */
export type CacheMode = "default" | "force" | "bypass";

/** Reads `x-switchyard-cache`; any value other than `force` or `bypass` is a 400. */
export function parseCacheHeader(value: string | string[] | undefined): CacheMode {
  if (value === undefined) return "default";
  const mode = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (mode === "force" || mode === "bypass") return mode;
  throw invalidCacheHeader();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `n` absent (or null) or 1: requests with more choices are never cached. */
const singleChoice = (request: ChatRequest) =>
  request.n === undefined || request.n === null || request.n === 1;

/** Exact cache: `temperature: 0` (present), or `force`; one choice; never with `bypass`. */
export function exactEligible(request: ChatRequest, mode: CacheMode): boolean {
  if (mode === "bypass" || !singleChoice(request)) return false;
  return mode === "force" || request.temperature === 0;
}

const present = (value: unknown) =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * Semantic cache (ADR-0009): temperature present and ≤ the cap, no tools, one choice, and a final
 * user message with text. `force` relaxes nothing.
 */
export function semanticEligible(
  request: ChatRequest,
  maxTemperature: number,
  mode: CacheMode,
): boolean {
  if (mode === "bypass" || !singleChoice(request)) return false;
  const { temperature } = request;
  if (typeof temperature !== "number" || temperature > maxTemperature) return false;
  if (present(request.tools) || present(request.functions) || present(request.tool_choice)) {
    return false;
  }
  return lastUserText(request) !== undefined;
}

/**
 * Text of the final message when it is a user message: a non-empty string, or text parts only
 * (joined with a newline). Anything else (images, audio, another role) gives undefined.
 */
export function lastUserText(request: ChatRequest): string | undefined {
  const last = request.messages.at(-1);
  if (last?.role !== "user") return undefined;
  const { content } = last;
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const texts: string[] = [];
  for (const part of content as unknown[]) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return undefined;
    texts.push(part.text);
  }
  const text = texts.join("\n");
  return text.length > 0 ? text : undefined;
}
