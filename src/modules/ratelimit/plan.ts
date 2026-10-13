import type { Principal } from "../../core/auth.js";
import type { BucketSpec } from "../../core/ratelimit.js";

export type LimitScope = "key" | "team" | "ip";
export type LimitKind = "requests" | "tokens";

export interface PlannedBucket extends BucketSpec {
  scope: LimitScope;
  kind: LimitKind;
}

export interface Plan {
  buckets: PlannedBucket[];
  /** Set when the token estimate can never fit a bucket (AC-5 → 400). */
  oversized?: { scope: LimitScope; capacity: number };
}

export interface DefaultLimits {
  rpm?: number | undefined;
  tpm?: number | undefined;
}

export const bucketKey = (scope: LimitScope, id: string, kind: LimitKind) =>
  `sy:rl:${scope}:${id}:${kind === "requests" ? "req" : "tok"}`;

/**
 * Buckets a request must debit (spec 005): key limits (own, else config defaults) and
 * team caps (own only). Unlimited dimensions produce no bucket.
 */
export function buildPlan(principal: Principal, defaults: DefaultLimits, estimate: number): Plan {
  const buckets: PlannedBucket[] = [];
  const add = (scope: LimitScope, id: string, rpm: number | null, tpm: number | null) => {
    if (rpm)
      buckets.push({
        key: bucketKey(scope, id, "requests"),
        capacity: rpm,
        cost: 1,
        scope,
        kind: "requests",
      });
    if (tpm)
      buckets.push({
        key: bucketKey(scope, id, "tokens"),
        capacity: tpm,
        cost: estimate,
        scope,
        kind: "tokens",
      });
  };

  add(
    "key",
    principal.keyId,
    principal.keyLimits.rpm ?? defaults.rpm ?? null,
    principal.keyLimits.tpm ?? defaults.tpm ?? null,
  );
  add("team", principal.teamId, principal.teamLimits.rpm, principal.teamLimits.tpm);

  const tooBig = buckets.find((b) => b.kind === "tokens" && b.cost > b.capacity);
  return tooBig
    ? { buckets, oversized: { scope: tooBig.scope, capacity: tooBig.capacity } }
    : { buckets };
}
