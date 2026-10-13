import { describe, expect, it } from "vitest";
import type { Principal } from "../../../src/core/auth.js";
import { buildPlan } from "../../../src/modules/ratelimit/plan.js";

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  keyId: "k1",
  teamId: "t1",
  allowedModels: null,
  keyLimits: { rpm: null, tpm: null },
  teamLimits: { rpm: null, tpm: null },
  ...overrides,
});

describe("buildPlan", () => {
  it("is empty when nothing is limited", () => {
    expect(buildPlan(principal(), {}, 100)).toEqual({ buckets: [] });
  });

  it("uses config defaults for keys without their own limits", () => {
    const plan = buildPlan(principal(), { rpm: 60, tpm: 1_000 }, 100);
    expect(plan.buckets).toEqual([
      { key: "sy:rl:key:k1:req", capacity: 60, cost: 1, scope: "key", kind: "requests" },
      { key: "sy:rl:key:k1:tok", capacity: 1_000, cost: 100, scope: "key", kind: "tokens" },
    ]);
  });

  it("prefers the key's own limits and adds team caps", () => {
    const plan = buildPlan(
      principal({ keyLimits: { rpm: 5, tpm: null }, teamLimits: { rpm: 100, tpm: 50_000 } }),
      { rpm: 60, tpm: 1_000 },
      100,
    );
    expect(plan.buckets.map((b) => [b.key, b.capacity, b.cost])).toEqual([
      ["sy:rl:key:k1:req", 5, 1],
      ["sy:rl:key:k1:tok", 1_000, 100],
      ["sy:rl:team:t1:req", 100, 1],
      ["sy:rl:team:t1:tok", 50_000, 100],
    ]);
  });

  it("flags a request whose estimate exceeds a token bucket capacity", () => {
    const plan = buildPlan(principal({ teamLimits: { rpm: null, tpm: 50 } }), {}, 100);
    expect(plan.oversized).toEqual({ scope: "team", capacity: 50 });
  });
});
