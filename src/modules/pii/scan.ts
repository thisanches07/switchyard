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
 * none of its characters is taken yet, so every character is replaced at most once. The
 * occupancy map keeps this linear in the total candidate length.
 */
export function resolveOverlaps(candidates: Detection[], textLength: number): Detection[] {
  if (candidates.length <= 1) return candidates;
  const ordered = [...candidates].sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) || RANK[a.type] - RANK[b.type] || a.start - b.start,
  );
  const taken = new Uint8Array(textLength);
  const kept: Detection[] = [];
  for (const candidate of ordered) {
    let free = true;
    for (let i = candidate.start; i < candidate.end && free; i += 1) free = taken[i] === 0;
    if (!free) continue;
    taken.fill(1, candidate.start, candidate.end);
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}
