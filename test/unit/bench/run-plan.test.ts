import { describe, expect, it } from "vitest";
import { loadBenchConfig } from "../../../bench/lib/config.ts";
import { classifyPass, planScenario, worst } from "../../../bench/lib/plan.ts";

const config = loadBenchConfig();
const keys = { main: "sk-main", limited: "sk-limited" };
const params = (name: Parameters<typeof planScenario>[0]) => config.profiles.full.scenarios[name];

describe("scenario plan (AC-2, AC-3)", () => {
  it("runs the direct baseline before the gateway for no-cache and streaming", () => {
    for (const scenario of ["no-cache", "streaming"] as const) {
      const passes = planScenario(scenario, params(scenario), keys);
      expect(passes.map((p) => p.target)).toEqual(["direct", "gateway"]);
      const [direct, gateway] = passes;
      expect(direct?.env).toMatchObject({
        MODE: "direct",
        BASE_URL: "http://mock-upstream:9100",
        MODEL: "bench",
      });
      expect(direct?.env.API_KEY).toBeUndefined();
      expect(gateway?.env).toMatchObject({
        MODE: "gateway",
        BASE_URL: "http://gateway:8080",
        MODEL: "upstream/bench",
        API_KEY: "sk-main",
      });
      // Same request shape and arrival rate on both targets (ADR-0021).
      for (const key of ["RATE", "WARMUP_SECONDS", "STEADY_SECONDS"]) {
        expect(direct?.env[key]).toBe(gateway?.env[key]);
      }
      expect(gateway?.script).toBe(`/scripts/${scenario}.js`);
    }
  });

  it("targets the cache-enabled gateway, the limited key and the chaos alias", () => {
    const [cache] = planScenario("exact-cache", params("exact-cache"), keys);
    expect(cache?.env).toMatchObject({
      BASE_URL: "http://gateway-cache:8080",
      REQUIRE_CACHE_HEADER: String(params("exact-cache").requireCacheHeader),
    });
    expect(planScenario("rate-limited", params("rate-limited"), keys)[0]?.env.API_KEY).toBe(
      "sk-limited",
    );
    const chaos = planScenario("chaos", params("chaos"), keys);
    expect(chaos).toHaveLength(1);
    expect(chaos[0]?.env.MODEL).toBe("bench-chaos");
    expect(chaos[0]?.env.RATE).toBe(String(params("chaos").rate));
  });
});

describe("k6 exit classification (AC-4)", () => {
  it("maps exit 99 to a correctness failure and anything else to a harness error", () => {
    expect(classifyPass(0, true)).toBe("passed");
    expect(classifyPass(99, true)).toBe("correctness-failed");
    expect(classifyPass(107, true)).toBe("harness-error");
    expect(classifyPass(0, false)).toBe("harness-error");
    expect(classifyPass(null, false)).toBe("harness-error");
  });

  it("keeps the worst status of a scenario's passes", () => {
    expect(worst([])).toBe("passed");
    expect(worst(["passed", "correctness-failed"])).toBe("correctness-failed");
    expect(worst(["harness-error", "correctness-failed"])).toBe("harness-error");
  });
});
