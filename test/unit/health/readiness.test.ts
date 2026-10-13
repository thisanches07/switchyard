import { describe, expect, it } from "vitest";
import { runReadiness } from "../../../src/modules/health/readiness.js";
import { failingCheck, hangingCheck, okCheck } from "../../helpers/checks.js";

describe("runReadiness", () => {
  it("all ok → ready", async () => {
    const result = await runReadiness([okCheck("postgres"), okCheck("redis")], 100);
    expect(result).toEqual({
      ready: true,
      checks: { postgres: "ok", redis: "ok" },
      failing: [],
    });
  });

  it("one failing → not_ready lists it", async () => {
    const result = await runReadiness([okCheck("postgres"), failingCheck("redis")], 100);
    expect(result).toEqual({
      ready: false,
      checks: { postgres: "ok", redis: "error" },
      failing: ["redis"],
    });
  });

  it("hanging check → timeout within budget and is aborted", async () => {
    const hanging = hangingCheck("postgres");
    const started = performance.now();
    const result = await runReadiness([hanging.check, okCheck("redis")], 50);
    const elapsed = performance.now() - started;

    expect(result.checks).toEqual({ postgres: "timeout", redis: "ok" });
    expect(result.failing).toEqual(["postgres"]);
    expect(elapsed).toBeLessThan(500);
    expect(hanging.state.aborted).toBe(true);
  });

  it("no checks → ready", async () => {
    expect(await runReadiness([], 50)).toEqual({ ready: true, checks: {}, failing: [] });
  });
});
