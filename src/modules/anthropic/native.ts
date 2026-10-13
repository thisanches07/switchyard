/**
 * Same-family upstream body (spec 014, AC-7; ADR-0016): the client's Anthropic body with the
 * resolved model, and any canonical text a feature changed (e.g. PII masking) written back into
 * the block it came from. Everything else (thinking, documents, cache_control, server tools,
 * unknown fields) is re-emitted untouched. Pure: the client body is never mutated.
 */
import type { AnthropicExtension, JsonPath } from "../../core/anthropic.js";
import type { ChatRequest } from "../../core/chat.js";
import { invalidToolArguments } from "../../core/errors.js";

export function nativeRequestBody(
  extension: AnthropicExtension,
  request: ChatRequest,
): Record<string, unknown> {
  const body = structuredClone(extension.body) as Record<string, unknown>;
  body.model = request.model;
  for (const slot of extension.slots) {
    const current = read(request, slot.canonical);
    if (typeof current !== "string" || current === slot.original) continue;
    write(body, slot.native, slot.kind === "json" ? parseObject(current, slot.native) : current);
  }
  return body;
}

function read(root: unknown, path: JsonPath): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

function write(root: Record<string, unknown>, path: JsonPath, value: unknown): void {
  const parent = read(root, path.slice(0, -1));
  const key = path.at(-1);
  if (typeof parent === "object" && parent !== null && key !== undefined) {
    (parent as Record<string | number, unknown>)[key] = value;
  }
}

function parseObject(text: string, at: JsonPath): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // reported below
  }
  throw invalidToolArguments(`${at.join(".")}: tool arguments must be a JSON object`);
}
