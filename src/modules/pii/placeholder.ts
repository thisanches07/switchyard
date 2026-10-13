import { PII_TYPES, type PiiType } from "../../core/pii.js";

/** Placeholder → original value for one request. Lives only in that request's memory. */
export type RestoreMap = ReadonlyMap<string, string>;

/** `<TYPE_n>`: upper-case detector type, counter from 1 (ADR-0015). */
export const placeholder = (type: PiiType, n: number) => `<${type.toUpperCase()}_${n}>`;

/** Exact placeholder shape, bounded (no leading zeros, at most 9 digits). */
export const PLACEHOLDER_PATTERN = new RegExp(
  `<(${PII_TYPES.map((t) => t.toUpperCase()).join("|")})_([1-9][0-9]{0,8})>`,
  "g",
);

/**
 * Highest `n` per type among placeholder-shaped strings the client already sent, so numbering
 * starts after them and restore never rewrites the client's own text (spec 010 open question).
 */
export function highestPlaceholders(texts: Iterable<string>): Map<PiiType, number> {
  const highest = new Map<PiiType, number>();
  for (const text of texts) {
    if (!text.includes("<")) continue;
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      const type = (match[1] ?? "").toLowerCase() as PiiType;
      highest.set(type, Math.max(highest.get(type) ?? 0, Number(match[2])));
    }
  }
  return highest;
}
