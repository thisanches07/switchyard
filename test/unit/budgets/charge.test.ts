import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BudgetRef } from "../../../src/core/budget.js";
import { createLogger } from "../../../src/infra/logger.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";
import { createBudgetCharger } from "../../../src/modules/budgets/charge.js";
import { createRatioGauge, type RatioGauge } from "../../../src/modules/budgets/gauge.js";
import { captureLogs } from "../../helpers/log-capture.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { sampleEvent } from "../../helpers/usage.js";

const TEAM = "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
const KEY = "0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
const key: BudgetRef = { scope: "key", id: KEY };
const team: BudgetRef = { scope: "team", id: TEAM };
const NOW = Date.parse("2026-10-13T12:00:00Z");
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("budget charger (spec 007, AC-10/AC-11/AC-13)", () => {
  let metrics: ReturnType<typeof installTestMetrics>;
  const gauges: RatioGauge[] = [];
  beforeEach(() => {
    metrics = installTestMetrics();
  });
  afterEach(async () => {
    for (const gauge of gauges.splice(0)) gauge.close();
    await metrics.uninstall();
  });

  function setup(now = () => NOW) {
    const counters = new MemoryBudgetCounters({ now });
    const logs = captureLogs();
    const gauge = createRatioGauge({ now });
    gauges.push(gauge);
    const charger = createBudgetCharger({
      counters,
      gauge,
      logger: createLogger({ level: "info", destination: logs.stream }),
      now,
    });
    return { counters, gauge, charger, logs: logs.lines };
  }

  it("adds a known cost to the key's and the team's counters of the event's period", async () => {
    const { counters, charger } = setup();
    charger.record(sampleEvent({ costUsd: "0.0000140000" }));
    charger.record(
      sampleEvent({ costUsd: "1.0000000000", occurredAt: "2026-10-31T23:59:59.999Z" }),
    );
    charger.record(sampleEvent({ costUsd: "2", occurredAt: "2026-11-01T00:00:00.000Z" }));
    await settle();
    expect(await counters.read("2026-10", [key, team])).toEqual(["1.000014", "1.000014"]);
    expect(await counters.read("2026-11", [key, team])).toEqual(["2", "2"]);
  });

  it("charges nothing for unknown, zero or no-upstream costs", async () => {
    const { counters, charger } = setup();
    charger.record(sampleEvent({ costUsd: null }));
    charger.record(sampleEvent({ costUsd: "0.0000000000" }));
    charger.record(sampleEvent({ costUsd: "0", provider: null, servedModel: null, attempts: 0 }));
    await settle();
    expect(await counters.read("2026-10", [key, team])).toEqual(["0", "0"]);
  });

  it("never throws when charging fails: counts it and warns at most once a minute", async () => {
    let now = NOW;
    const { counters, charger, logs } = setup(() => now);
    counters.failing = true;
    expect(() => charger.record(sampleEvent({ costUsd: "1" }))).not.toThrow();
    charger.record(sampleEvent({ costUsd: "1" }));
    await settle();
    now += 60_000;
    charger.record(sampleEvent({ costUsd: "1" }));
    await settle();
    expect(await metrics.points("switchyard_budget_charge_failures_total")).toEqual([
      expect.objectContaining({ value: 3 }),
    ]);
    const warnings = logs.filter((l) => l.msg === "budget counters could not be charged");
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).not.toContain("sk-sy-");
  });

  it("updates the used-ratio gauge of tracked scopes after a charge", async () => {
    const { gauge, charger } = setup();
    gauge.track(key, "4", "2026-10", "0");
    charger.record(sampleEvent({ costUsd: "1" }));
    charger.record(sampleEvent({ costUsd: "1" }));
    await settle();
    // The counter went 0 → 1 → 2 of a $4 budget; the untracked team has no series.
    expect(await metrics.points("switchyard_budget_used_ratio")).toEqual([
      expect.objectContaining({ attributes: { scope: "key", id: KEY }, value: 0.5 }),
    ]);
  });
});

describe("used-ratio gauge (spec 007, AC-13)", () => {
  let metrics: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    metrics = installTestMetrics();
  });
  afterEach(async () => {
    await metrics.uninstall();
  });

  it("reports spend ÷ budget, may exceed 1, and treats a budget of 0 as used", async () => {
    const gauge = createRatioGauge({ now: () => NOW });
    gauge.track(key, "10", "2026-10", "12.5");
    gauge.track(team, "0", "2026-10", "0");
    expect(gauge.observe()).toEqual([
      { scope: "key", id: KEY, ratio: 1.25 },
      { scope: "team", id: TEAM, ratio: 1 },
    ]);
    gauge.close();
    expect(await metrics.points("switchyard_budget_used_ratio")).toEqual([]);
  });

  it("removes a series when the budget is cleared and hides past periods", () => {
    let now = NOW;
    const gauge = createRatioGauge({ now: () => now });
    gauge.track(key, "10", "2026-10", "1");
    gauge.track(team, "10", "2026-10", "1");
    gauge.forget(team);
    expect(gauge.observe().map((s) => s.scope)).toEqual(["key"]);
    gauge.charged(key, "2026-11", "9"); // another period: ignored
    expect(gauge.observe()[0]?.ratio).toBe(0.1);
    now = Date.parse("2026-11-01T00:00:00Z");
    expect(gauge.observe()).toEqual([]);
    gauge.close();
  });

  it("is replaced wholesale by reconciliation and stays bounded", () => {
    const gauge = createRatioGauge({ now: () => NOW, maxEntries: 2 });
    gauge.track(key, "10", "2026-10", "1");
    gauge.replace("2026-10", [
      { ref: team, limitUsd: "4", spentUsd: "1" },
      { ref: { scope: "key", id: "a" }, limitUsd: "1", spentUsd: "1" },
      { ref: { scope: "key", id: "b" }, limitUsd: "1", spentUsd: "0" },
    ]);
    expect(gauge.observe()).toEqual([
      { scope: "key", id: "a", ratio: 1 },
      { scope: "key", id: "b", ratio: 0 },
    ]);
    gauge.close();
  });
});
