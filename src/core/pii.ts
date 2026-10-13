/**
 * PII redaction types (spec 010, ADR-0015). Only types and counts live here: detected values and
 * the placeholder → value map never leave the request that built them (ADR-0010).
 */

/** Detector types in canonical (alphabetical) order: error messages list types in this order. */
export const PII_TYPES = ["card", "cnpj", "cpf", "email", "ip", "phone", "term"] as const;
export type PiiType = (typeof PII_TYPES)[number];

/** Per-key mode: `off` never scans, `mask` replaces and restores, `block` refuses. */
export const PII_MODES = ["off", "mask", "block"] as const;
export type PiiMode = (typeof PII_MODES)[number];

export type PiiAction = "none" | "masked" | "blocked";

/** Occurrences per detector type; types with no detection are absent. */
export type PiiDetections = Partial<Record<PiiType, number>>;

/**
 * What one admitted request did about PII: read by telemetry and by the request-outcome hook
 * (spec 006, `UsageEvent.piiDetections`). Never holds a detected value.
 */
export interface PiiRequestResult {
  mode: PiiMode;
  action: PiiAction;
  detections: PiiDetections;
  /** True when part of the input could not be inspected (token-array embeddings input). */
  uninspected?: boolean;
}
