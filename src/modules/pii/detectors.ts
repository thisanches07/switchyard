import type { PiiType } from "../../core/pii.js";
import { isBrazilianDdd, isCnpj, isCpf, isEmailDomain, isIpAddress, luhn } from "./validators.js";

/**
 * Pattern detectors (spec 010, ADR-0015). Every pattern is global and uses **bounded**
 * quantifiers only, with look-arounds on its own character class so a candidate can neither
 * start nor end inside a longer run: scanning stays linear in the input (AC-6, enforced by
 * `linear.test.ts`). Each candidate is then confirmed by `accept`, which returns the accepted
 * length (0 = rejected).
 */
export interface PatternDetector {
  type: PiiType;
  pattern: RegExp;
  accept(match: RegExpExecArray): number;
}

const whole = (match: RegExpExecArray) => match[0].length;

/** Length of `value` without trailing characters in `chars`. */
function trimEnd(value: string, chars: string): number {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1] ?? "")) end -= 1;
  return end;
}

export const PATTERN_DETECTORS: readonly PatternDetector[] = [
  {
    type: "email",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}/g,
    accept(match) {
      const at = match[0].indexOf("@");
      const domain = match[0].slice(at + 1);
      const end = trimEnd(domain, ".-");
      return isEmailDomain(domain.slice(0, end)) ? at + 1 + end : 0;
    },
  },
  {
    // Brazilian landline and mobile numbers: optional +55, DDD with or without parentheses.
    type: "phone",
    pattern:
      /(?<![0-9A-Za-z+])(?:\+?55[ -]?)?(?:\(([1-9][0-9])\)|([1-9][0-9]))[ -]?(?:9[0-9]{4}|[2-5][0-9]{3})[ -]?[0-9]{4}(?![0-9])/g,
    accept: (match) => (isBrazilianDdd(match[1] ?? match[2] ?? "") ? match[0].length : 0),
  },
  {
    // International numbers in E.164.
    type: "phone",
    pattern: /(?<![0-9A-Za-z+])\+[1-9][0-9]{7,14}(?![0-9])/g,
    accept: whole,
  },
  {
    type: "card",
    pattern: /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g,
    accept: (match) => (luhn(match[0]) ? match[0].length : 0),
  },
  {
    type: "cpf",
    pattern: /(?<![0-9])(?:[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|[0-9]{11})(?![0-9])/g,
    accept: (match) => (isCpf(match[0]) ? match[0].length : 0),
  },
  {
    // Numeric and alphanumeric (2026) CNPJ, formatted or not; letters are upper case only.
    type: "cnpj",
    pattern:
      /(?<![0-9A-Za-z])(?:[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4}-[0-9]{2}|[0-9A-Z]{12}[0-9]{2})(?![0-9A-Za-z])/g,
    accept: (match) => (isCnpj(match[0]) ? match[0].length : 0),
  },
  {
    type: "ip",
    pattern: /(?<![0-9A-Za-z_.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9A-Za-z_]|\.[0-9])/g,
    accept: (match) => (isIpAddress(match[0]) ? match[0].length : 0),
  },
  {
    // IPv6 (full, compressed, IPv4-mapped): a run of address characters, confirmed by a parser.
    type: "ip",
    pattern: /(?<![0-9A-Za-z_:.])[0-9A-Fa-f:.]{2,45}(?![0-9A-Za-z_:.])/g,
    accept(match) {
      const end = trimEnd(match[0], ".");
      const candidate = match[0].slice(0, end);
      return candidate.split(":").length > 2 && isIpAddress(candidate) ? end : 0;
    },
  },
];

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Lower-cases without changing the length, so indexes map back to the original text. */
export function lowerSameLength(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const char of text) {
    const lowered = char.toLowerCase();
    out += lowered.length === char.length ? lowered : char;
  }
  return out;
}

/** The code point just before `index` (handles surrogate pairs), or "". */
function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const code = text.codePointAt(index - 1) ?? 0;
  if (index >= 2 && code >= 0xdc00 && code <= 0xdfff) {
    return String.fromCodePoint(text.codePointAt(index - 2) ?? 0);
  }
  return String.fromCodePoint(code);
}

function charAt(text: string, index: number): string {
  if (index >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(index) ?? 0);
}

/**
 * Deny-list terms (`pii.denyList`): literal, case-insensitive matches on word boundaries.
 * Terms are never compiled into regular expressions. `terms` must be lower-cased already.
 */
export function findTerms(
  text: string,
  terms: readonly string[],
): { start: number; end: number }[] {
  if (terms.length === 0) return [];
  const lower = lowerSameLength(text);
  const found: { start: number; end: number }[] = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index !== -1) {
      const end = index + term.length;
      if (!WORD_CHAR.test(charBefore(text, index)) && !WORD_CHAR.test(charAt(text, end))) {
        found.push({ start: index, end });
      }
      index = lower.indexOf(term, index + 1);
    }
  }
  return found;
}
