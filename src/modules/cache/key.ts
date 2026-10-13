/**
 * Cache keys (spec 009, ADR-0019): canonical JSON of the request as sent upstream, minus a
 * denylist of fields that do not affect the output, hashed with SHA-256. The same canonical form
 * gives the semantic cache's `params_hash` (ADR-0009). Pure; nothing here is ever logged.
 */
import { createHash } from "node:crypto";
import type { ChatMessage, ChatRequest } from "../../core/chat.js";

/** Bump with any rule change: old entries are then never read again (ADR-0019). */
const VERSION = 1;
const PREFIX = `sy:cache:exact:v${VERSION}`;

/** Request fields that never affect the output (ADR-0019); `n` is excluded only when it is 1. */
const EXCLUDED = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "user",
  "metadata",
  "store",
  "service_tier",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Code-unit order: independent of the process locale, unlike `localeCompare`. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON with object keys sorted by code unit at every level, no insignificant whitespace, numbers
 * in their shortest form (`JSON.stringify`), strings byte for byte, array order kept.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Drops fields whose value is null (top level of one object only). */
function withoutNulls(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== null));
}

/** Messages and output-affecting parameters of a request, normalised as ADR-0019 says. */
function normalise(request: ChatRequest): { messages: unknown[]; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(request)) {
    if (EXCLUDED.has(name) || value === null || value === undefined) continue;
    if (name === "n" && value === 1) continue;
    params[name] = value;
  }
  const messages = request.messages.map((m: ChatMessage) => (isRecord(m) ? withoutNulls(m) : m));
  return { messages, params };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Redis key of `request` for one team and candidate `provider/model`. */
export function exactKey(teamId: string, candidate: string, request: ChatRequest): string {
  const { messages, params } = normalise(request);
  const hash = sha256(
    canonicalJson({ v: VERSION, team: teamId, model: candidate, messages, params }),
  );
  return `${PREFIX}:${teamId}:${candidate}:${hash}`;
}

/**
 * Semantic scope hash: the same canonical form without the final user message (the embedded
 * part) and without team or model (separate columns, ADR-0009).
 */
export function paramsHash(request: ChatRequest): string {
  const { messages, params } = normalise(request);
  const last = request.messages.at(-1);
  const scoped = last?.role === "user" ? messages.slice(0, -1) : messages;
  return sha256(canonicalJson({ v: VERSION, messages: scoped, params }));
}
