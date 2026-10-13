import { createHash, randomBytes } from "node:crypto";

export const KEY_PREFIX = "sk-sy-";
const KEY_BYTES = 32;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** ceil(256 bits / log2(62)): fixed width so every key has the same length. */
const ENCODED_LENGTH = 43;

/** A new virtual API key: `sk-sy-` + 32 random bytes in base62 (spec 004, AC-2). */
export function generateKey(random: (size: number) => Buffer = randomBytes): string {
  let value = BigInt(`0x${random(KEY_BYTES).toString("hex") || "0"}`);
  let encoded = "";
  while (value > 0n) {
    encoded = ALPHABET[Number(value % 62n)] + encoded;
    value /= 62n;
  }
  return KEY_PREFIX + encoded.padStart(ENCODED_LENGTH, "0");
}

/** What the database stores: hex SHA-256 of pepper + key. The key itself is never stored. */
export function hashKey(pepper: string, key: string): string {
  return createHash("sha256").update(pepper).update(key).digest("hex");
}

/** Non-secret identifier shown in listings (`sk-sy-` + 4 characters). */
export function displayPrefix(key: string): string {
  return key.slice(0, 10);
}

export type ExtractedKey = { token: string } | { reason: "missing" | "malformed" };

/**
 * The gateway key from `Authorization: Bearer …` or `x-api-key` (spec 014: Anthropic SDKs send
 * the latter). Both present and different, or a malformed header, is `malformed`.
 */
export function extractApiKey(headers: {
  authorization?: string | undefined;
  "x-api-key"?: string | string[] | undefined;
}): ExtractedKey {
  const { authorization } = headers;
  const apiKeyHeader = headers["x-api-key"];
  if (authorization === undefined && apiKeyHeader === undefined) return { reason: "missing" };

  const bearer = authorization === undefined ? undefined : parseBearer(authorization);
  if (authorization !== undefined && bearer === undefined) return { reason: "malformed" };
  const apiKey = typeof apiKeyHeader === "string" ? apiKeyHeader.trim() : undefined;
  if (apiKeyHeader !== undefined && !apiKey) return { reason: "malformed" };

  if (bearer !== undefined && apiKey !== undefined && bearer !== apiKey) {
    return { reason: "malformed" };
  }
  const token = bearer ?? apiKey;
  return token ? { token } : { reason: "missing" };
}

/** Extracts the token from `Authorization: Bearer <token>`; undefined if absent or malformed. */
export function parseBearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match?.[1];
}
