import { isIPv4, isIPv6 } from "node:net";

/**
 * Validators that confirm a pattern candidate (spec 010, ADR-0015). Pure functions: they keep
 * false positives rare (check digits, Luhn, real address parsers) and never see more than one
 * candidate at a time.
 */

const digitsOf = (value: string) => value.replace(/[^0-9]/g, "");

/** True when every character is the same (`11111111111`, `0000…`): never a real identifier. */
const isRepeated = (value: string) =>
  value.length > 0 && value.split("").every((c) => c === value[0]);

/** Luhn check for card numbers of 13 to 19 digits; separators are ignored. */
export function luhn(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length < 13 || digits.length > 19 || isRepeated(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Mod-11 check digit used by CPF and CNPJ: weights applied to `values`. */
function mod11(values: number[], weights: number[]): number {
  const sum = values.reduce((acc, value, i) => acc + value * (weights[i] ?? 0), 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** CPF (`529.982.247-25` or `52998224725`): both check digits, no repeated-digit sequences. */
export function isCpf(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 11 || isRepeated(digits)) return false;
  const values = digits.split("").map(Number);
  const first = mod11(values.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = mod11(values.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return values[9] === first && values[10] === second;
}

const CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * CNPJ, numeric or alphanumeric (2026 format: `[0-9A-Z]` in the first 12 positions, numeric
 * check digits). Each character counts as its char code minus 48, which is the plain digit for
 * `0`-`9`. Separators (`.`, `/`, `-`) are ignored; lower case is not a CNPJ.
 */
export function isCnpj(value: string): boolean {
  const chars = value.replace(/[./-]/g, "");
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(chars) || isRepeated(chars)) return false;
  const values = chars.split("").map((c) => c.charCodeAt(0) - 48);
  const first = mod11(values.slice(0, 12), CNPJ_WEIGHTS);
  const second = mod11(values.slice(0, 13), [6, ...CNPJ_WEIGHTS]);
  return values[12] === first && values[13] === second;
}

/** Area codes (DDD) in use in Brazil (ANATEL). */
const BRAZILIAN_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function isBrazilianDdd(ddd: string): boolean {
  return /^[0-9]{2}$/.test(ddd) && BRAZILIAN_DDDS.has(Number(ddd));
}

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TLD = /^[A-Za-z]{2,24}$/;

/** E-mail domain: at least two labels of 1-63 characters, alphabetic top-level domain. */
export function isEmailDomain(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253) return false;
  return labels.every((label) => LABEL.test(label)) && TLD.test(labels.at(-1) ?? "");
}

/** IPv4 or IPv6 according to Node's own address parser; the unspecified `::` is not data. */
export function isIpAddress(value: string): boolean {
  if (value === "::") return false;
  return isIPv4(value) || isIPv6(value);
}
