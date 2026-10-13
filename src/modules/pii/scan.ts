import { PII_TYPES, type PiiType } from "../../core/pii.js";
import { findTerms, lowerSameLength, PATTERN_DETECTORS } from "./detectors.js";

/** One detected value, as a half-open range of the scanned text. Never logged. */
export interface Detection {
  type: PiiType;
  start: number;
  end: number;
}

export interface ScannerOptions {
  /** Detector types to run (`pii.detectors`); others never run. */
  types: readonly PiiType[];
  /** Literal deny-list terms (`pii.denyList`), used when `term` is enabled. */
  denyList: readonly string[];
}

export type Scanner = (text: string) => Detection[];

/**
 * Tie-break between candidates of the same length (AC-5): validator-backed types first, most
 * specific first (two check digits beat Luhn's one), then the others in canonical order.
 */
const RANK: Record<PiiType, number> = Object.fromEntries(
  [
    "cnpj",
    "cpf",
    "card",
    ...PII_TYPES.filter((t) => t !== "cnpj" && t !== "cpf" && t !== "card"),
  ].map((type, rank) => [type, rank]),
) as Record<PiiType, number>;

/** Builds a scanner for one configuration (patterns are shared; terms prepared once). */
export function createScanner(options: ScannerOptions): Scanner {
  const enabled = new Set(options.types);
  const detectors = PATTERN_DETECTORS.filter((d) => enabled.has(d.type));
  const terms = enabled.has("term")
    ? [...new Set(options.denyList.map((t) => lowerSameLength(t)).filter((t) => t.length > 0))]
    : [];

  return (text) => {
    if (text.length === 0) return [];
    const candidates: Detection[] = [];
    for (const detector of detectors) {
      for (const match of text.matchAll(detector.pattern)) {
        const length = detector.accept(match);
        if (length > 0) {
          candidates.push({ type: detector.type, start: match.index, end: match.index + length });
        }
      }
    }
    for (const { start, end } of findTerms(text, terms)) {
      candidates.push({ type: "term", start, end });
    }
    return resolveOverlaps(candidates, text.length);
  };
}

/**
 * Longest match first, then validator-backed types, then position; a candidate is kept only if
 * none of its characters is taken yet, so every character is replaced at most once.
 *
 * Linear in the input: candidates are bucketed by (length, rank) instead of being sorted (each
 * detector yields them in increasing position already), an occupancy map answers "is this range
 * free", and the result is read back in text order from a position index.
 */
export function resolveOverlaps(candidates: Detection[], textLength: number): Detection[] {
  if (candidates.length <= 1) return candidates;
  const buckets = new Map<number, Detection[]>();
  for (const candidate of candidates) {
    const key = (candidate.end - candidate.start) * 16 + (15 - RANK[candidate.type]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }
  // taken[i] = 1 + index (in `accepted`) of the detection covering character i, 0 when free.
  const taken = new Int32Array(textLength);
  const accepted: Detection[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => b - a)) {
    for (const candidate of buckets.get(key) ?? []) {
      let free = true;
      for (let i = candidate.start; i < candidate.end && free; i += 1) free = taken[i] === 0;
      if (!free) continue;
      accepted.push(candidate);
      for (let i = candidate.start; i < candidate.end; i += 1) taken[i] = accepted.length;
    }
  }
  const kept: Detection[] = [];
  for (let i = 0; i < textLength && kept.length < accepted.length; i += 1) {
    const slot = taken[i] ?? 0;
    if (slot === 0) continue;
    const candidate = accepted[slot - 1];
    if (candidate?.start === i) kept.push(candidate);
  }
  return kept;
}
