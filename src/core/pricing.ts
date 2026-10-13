/**
 * Pricing port (spec 007), shared with routing (spec 008, `lowest-cost`). Prices come from
 * `config/pricing.yaml`; a missing or `TODO` price is unknown, never 0 (CLAUDE.md, ADR-0017).
 */

/** Token counts of one request; `cachedInputTokens` is provider-reported and part of `inputTokens`. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** Cost in USD for a served `provider/model`; undefined = unknown price (never 0). */
export interface CostEstimator {
  estimateUsd(modelRef: string, usage: TokenCounts): number | undefined;
}
