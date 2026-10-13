import type { Candidate, RoutingStrategy } from "./resolve.js";

export interface OrderContext {
  /** Estimated cost of this request on a candidate in USD; undefined = unknown price. */
  cost?: ((candidate: Candidate) => number | undefined) | undefined;
  /** EWMA latency of a candidate in ms; undefined = cold (no sample yet). */
  latency?: ((candidate: Candidate) => number | undefined) | undefined;
}

const known = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

/**
 * Orders candidates by an alias strategy (spec 008, AC-2). Pure; never mutates its input.
 * - `priority`: config order.
 * - `lowest-cost`: ascending estimated cost; unknown prices after every priced one, in config order.
 * - `lowest-latency`: cold candidates first (config order, so each gets measured), then ascending EWMA.
 * Ties keep config order (Array.prototype.sort is stable).
 */
export function orderCandidates(
  strategy: RoutingStrategy,
  candidates: readonly Candidate[],
  ctx: OrderContext,
): Candidate[] {
  const metric =
    strategy === "lowest-cost" ? ctx.cost : strategy === "lowest-latency" ? ctx.latency : undefined;
  if (!metric) return [...candidates];
  // Unknown values sort last for cost and first for latency (cold candidates get measured).
  const unknownRank = strategy === "lowest-cost" ? 1 : 0;
  const keyed = candidates.map((candidate) => {
    const value = metric(candidate);
    return known(value)
      ? { candidate, rank: 1 - unknownRank, value }
      : { candidate, rank: unknownRank, value: 0 };
  });
  keyed.sort((a, b) => a.rank - b.rank || a.value - b.value);
  return keyed.map((entry) => entry.candidate);
}
