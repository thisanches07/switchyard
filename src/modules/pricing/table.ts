/**
 * The price table of `config/pricing.yaml` (spec 007, AC-1/AC-2): entry lookup by precedence and
 * exact cost per request. Implements the `CostEstimator` port read by routing (spec 008).
 */
import type { CostEstimator, TokenCounts } from "../../core/pricing.js";
import { add, type Decimal, mulInt, shift, toFixed } from "./decimal.js";

/** USD per 1M tokens, or "TODO" (unknown, never 0). */
export type Price = Decimal | "TODO";

export interface PriceEntry {
  input: Price;
  output: Price;
  /** Provider prompt-cache reads; the input price applies when absent. */
  cachedInput?: Price;
}

interface Pattern {
  regex: RegExp;
  /** Non-`*` characters: more means more specific. */
  specificity: number;
  entry: PriceEntry;
}

/** Decimal places of every computed cost (ADR-0017). */
export const COST_SCALE = 10;
const PER_MILLION = 6;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const whole = (n: number | undefined) => Math.max(0, Math.round(n ?? 0));

export class PriceTable implements CostEstimator {
  readonly #exact = new Map<string, PriceEntry>();
  readonly #patterns: Pattern[] = [];

  /** Entries in file order (the order breaks ties between equally specific patterns). */
  constructor(entries: Iterable<readonly [string, PriceEntry]>) {
    for (const [key, entry] of entries) {
      if (!key.includes("*")) {
        this.#exact.set(key, entry);
        continue;
      }
      this.#patterns.push({
        regex: new RegExp(`^${key.split("*").map(escapeRegex).join(".*")}$`, "s"),
        specificity: key.replaceAll("*", "").length,
        entry,
      });
    }
  }

  /** A table without prices: every cost is unknown. */
  static empty(): PriceTable {
    return new PriceTable([]);
  }

  /** Exact key, else the most specific matching pattern, else the first listed (AC-1). */
  entryFor(modelRef: string): PriceEntry | undefined {
    const exact = this.#exact.get(modelRef);
    if (exact) return exact;
    let best: Pattern | undefined;
    for (const pattern of this.#patterns) {
      if (!pattern.regex.test(modelRef)) continue;
      if (!best || pattern.specificity > best.specificity) best = pattern;
    }
    return best?.entry;
  }

  /**
   * Exact cost in USD with 10 decimal places (AC-2), or null when unknown: no entry, or a needed
   * price is TODO. A price is needed only when its token count is above 0.
   */
  costUsd(modelRef: string, usage: TokenCounts): string | null {
    const entry = this.entryFor(modelRef);
    if (!entry) return null;
    const input = whole(usage.inputTokens);
    const cached = Math.min(whole(usage.cachedInputTokens), input);
    const terms: [number, Price][] = [
      [input - cached, entry.input],
      [cached, entry.cachedInput ?? entry.input],
      [whole(usage.outputTokens), entry.output],
    ];
    let total: Decimal = { units: 0n, scale: 0 };
    for (const [tokens, price] of terms) {
      if (tokens === 0) continue;
      if (price === "TODO") return null;
      total = add(total, mulInt(price, tokens));
    }
    return toFixed(shift(total, PER_MILLION), COST_SCALE);
  }

  estimateUsd(modelRef: string, usage: TokenCounts): number | undefined {
    const cost = this.costUsd(modelRef, usage);
    return cost === null ? undefined : Number(cost);
  }
}

/** Prices a finished request at its served `provider/model` (spec 007, AC-2). */
export function priceEvent(
  table: PriceTable,
): (event: TokenCounts & { provider: string | null; servedModel: string | null }) => string | null {
  return (event) =>
    event.provider === null || event.servedModel === null
      ? null
      : table.costUsd(`${event.provider}/${event.servedModel}`, event);
}

/**
 * Alias candidates whose input or output price is unknown (no entry, or TODO): the gateway logs
 * them once at boot (AC-1). Distinct, in alias order.
 */
export function unknownPriceCandidates(
  aliases: Readonly<Record<string, { candidates: readonly string[] }>>,
  table: PriceTable,
): string[] {
  const unknown = new Set<string>();
  for (const alias of Object.values(aliases)) {
    for (const ref of alias.candidates) {
      const entry = table.entryFor(ref);
      if (!entry || entry.input === "TODO" || entry.output === "TODO") unknown.add(ref);
    }
  }
  return [...unknown];
}
