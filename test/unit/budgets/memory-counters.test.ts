import { describe, expect, it } from "vitest";
import type { BudgetRef } from "../../../src/core/budget.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";

const key: BudgetRef = { scope: "key", id: "k1" };
const team: BudgetRef = { scope: "team", id: "t1" };

describe("MemoryBudgetCounters (spec 007, AC-10)", () => {
  it("reads 0 for counters that do not exist", async () => {
    const counters = new MemoryBudgetCounters();
    expect(await counters.read("2026-10", [key, team])).toEqual(["0", "0"]);
  });

  it("charges every ref and returns the new totals, per period", async () => {
    const counters = new MemoryBudgetCounters();
    const expireAt = Date.parse("2026-11-08T00:00:00Z");
    expect(await counters.charge("2026-10", [key, team], "0.0000140000", expireAt)).toEqual([
      "0.000014",
      "0.000014",
    ]);
    expect(await counters.charge("2026-10", [key], "0.1", expireAt)).toEqual(["0.100014"]);
    expect(await counters.read("2026-10", [key, team])).toEqual(["0.100014", "0.000014"]);
    expect(await counters.read("2026-11", [key])).toEqual(["0"]);
  });

  it("raises counters that are lower, never lowers one, and reports how many it raised", async () => {
    const counters = new MemoryBudgetCounters();
    const expireAt = Date.parse("2026-11-08T00:00:00Z");
    await counters.charge("2026-10", [key], "5", expireAt);
    const raised = await counters.raise(
      "2026-10",
      [
        { ref: key, spentUsd: "3" },
        { ref: team, spentUsd: "7.25" },
      ],
      expireAt,
    );
    expect(raised).toBe(1);
    expect(await counters.read("2026-10", [key, team])).toEqual(["5", "7.25"]);
  });

  it("expires counters at the given instant", async () => {
    let now = Date.parse("2026-11-07T00:00:00Z");
    const counters = new MemoryBudgetCounters({ now: () => now });
    await counters.charge("2026-10", [key], "1", Date.parse("2026-11-08T00:00:00Z"));
    expect(await counters.read("2026-10", [key])).toEqual(["1"]);
    now = Date.parse("2026-11-08T00:00:00Z");
    expect(await counters.read("2026-10", [key])).toEqual(["0"]);
  });

  it("can be made to fail, like an unreachable Redis", async () => {
    const counters = new MemoryBudgetCounters();
    counters.failing = true;
    await expect(counters.read("2026-10", [key])).rejects.toThrow(/unavailable/);
    await expect(counters.charge("2026-10", [key], "1", 0)).rejects.toThrow(/unavailable/);
    await expect(counters.raise("2026-10", [], 0)).rejects.toThrow(/unavailable/);
  });
});
