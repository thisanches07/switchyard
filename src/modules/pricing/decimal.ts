/**
 * Exact decimal arithmetic for costs and budgets (spec 007, ADR-0017). A value is
 * `units / 10^scale` with `units` a BigInt, so sums of tiny per-token costs never drift and
 * formatting never produces an exponent. Pure; no dependency.
 */

export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const PATTERN = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const pow10 = (n: number) => 10n ** BigInt(n);

/**
 * Parses a decimal string (`"0.15"`, `"-2"`, `"3E+2"`) or a finite JS number (from its shortest
 * round-trip form, so `0.15` is exactly 0.15 and `1e-7` is 0.0000001). Undefined when invalid.
 */
export function tryDecimal(value: string | number): Decimal | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  const match = PATTERN.exec(typeof value === "number" ? String(value) : value);
  if (!match) return undefined;
  const [, sign, whole = "0", fraction = "", exponent = "0"] = match;
  let units = BigInt(whole + fraction);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    units *= pow10(-scale);
    scale = 0;
  }
  return { units: sign === "-" ? -units : units, scale };
}

/** Like `tryDecimal`, but throws a RangeError for invalid input. */
export function decimal(value: string | number): Decimal {
  const parsed = tryDecimal(value);
  if (!parsed) throw new RangeError(`not a decimal number: ${String(value)}`);
  return parsed;
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function sub(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

/** Multiplies by an integer (e.g. a token count). */
export function mulInt(a: Decimal, n: number | bigint): Decimal {
  return { units: a.units * BigInt(n), scale: a.scale };
}

/** Divides by 10^n exactly (e.g. "per 1M tokens" is `shift(x, 6)`). */
export function shift(a: Decimal, n: number): Decimal {
  return { units: a.units, scale: a.scale + n };
}

export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Rounds half-up (half away from zero) to `scale` decimal places. */
export function round(a: Decimal, scale: number): Decimal {
  if (a.scale <= scale) return { units: a.units * pow10(scale - a.scale), scale };
  const divisor = pow10(a.scale - scale);
  const negative = a.units < 0n;
  const magnitude = negative ? -a.units : a.units;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;
  return { units: negative ? -quotient : quotient, scale };
}

/** Fixed-point string with exactly `scale` places (rounded half-up), never an exponent. */
export function toFixed(a: Decimal, scale: number): string {
  const { units } = round(a, scale);
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  const text = scale > 0 ? `${whole}.${fraction}` : whole;
  return negative && units !== 0n ? `-${text}` : text;
}

/** Shortest exact string: no trailing zeros, no exponent, never `-0`. */
export function normalize(a: Decimal): string {
  const text = toFixed(a, Math.max(0, a.scale));
  const trimmed = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}
