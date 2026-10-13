import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../../../src/core/auth.js";
import { GatewayError } from "../../../src/core/errors.js";
import { createLogger } from "../../../src/infra/logger.js";
import { MemoryBudgetCounters } from "../../../src/infra/memory/budget-counters.js";
import { createBudgetCheck, evaluateBudgets } from "../../../src/modules/budgets/check.js";
import { captureLogs } from "../../helpers/log-capture.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { installInMemoryTracing } from "../../helpers/telemetry.js";

const RESET = "2026-11-01T00:00:00.000Z";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const EXPIRY = Date.parse("2026-11-08T00:00:00Z");

describe("evaluateBudgets (spec 007, AC-6/AC-8/AC-9)", () => {
  const evaluate = (
    scopes: { scope: "key" | "team"; limitUsd: string; spentUsd: string }[],
    softLimitPct = 80,
  ) => evaluateBudgets({ scopes, softLimitPct, resetAt: RESET });

  it("allows below the soft limit and describes the budget in headers", () => {
    expect(evaluate([{ scope: "key", limitUsd: "10", spentUsd: "1.5" }])).toEqual({
      decision: "allow",
      scope: "key",
      soft: [],
      headers: {
        "x-switchyard-budget-limit-usd": "10",
        "x-switchyard-budget-remaining-usd": "8.5",
        "x-switchyard-budget-reset": RESET,
      },
    });
  });

  it("rejects when spend equals or exceeds the budget; a budget of 0 blocks", () => {
    expect(evaluate([{ scope: "key", limitUsd: "10", spentUsd: "10" }])).toMatchObject({
      decision: "reject",
      scope: "key",
      headers: { "x-switchyard-budget-remaining-usd": "0" },
    });
    expect(evaluate([{ scope: "team", limitUsd: "1", spentUsd: "1.0000001" }]).decision).toBe(
      "reject",
    );
    expect(evaluate([{ scope: "key", limitUsd: "0", spentUsd: "0" }]).decision).toBe("reject");
  });

  it("treats the Redis float at 10 decimal places", () => {
    expect(
      evaluate([{ scope: "key", limitUsd: "0.3", spentUsd: "0.30000000000000004" }]).decision,
    ).toBe("reject");
    expect(
      evaluate([{ scope: "key", limitUsd: "0.3", spentUsd: "0.29999999999999999" }]).decision,
    ).toBe("reject");
    expect(evaluate([{ scope: "key", limitUsd: "0.3", spentUsd: "0.2999999998" }]).decision).toBe(
      "soft",
    );
  });

  it("reports the scope with the lowest remaining budget; the key wins ties", () => {
    const team = evaluate([
      { scope: "key", limitUsd: "10", spentUsd: "1" },
      { scope: "team", limitUsd: "5", spentUsd: "0" },
    ]);
    expect(team.scope).toBe("team");
    expect(team.headers["x-switchyard-budget-limit-usd"]).toBe("5");
    expect(team.headers["x-switchyard-budget-remaining-usd"]).toBe("5");
    const tie = evaluate([
      { scope: "key", limitUsd: "5", spentUsd: "1" },
      { scope: "team", limitUsd: "4", spentUsd: "0" },
    ]);
    expect(tie.scope).toBe("key");
  });

  it("rejects on the exhausted scope, the key first when both are", () => {
    const team = evaluate([
      { scope: "key", limitUsd: "1", spentUsd: "0" },
      { scope: "team", limitUsd: "100", spentUsd: "100" },
    ]);
    expect(team).toMatchObject({ decision: "reject", scope: "team" });
    expect(team.headers["x-switchyard-budget-limit-usd"]).toBe("100");
    expect(
      evaluate([
        { scope: "key", limitUsd: "1", spentUsd: "2" },
        { scope: "team", limitUsd: "1", spentUsd: "2" },
      ]).scope,
    ).toBe("key");
  });

  it("warns from the soft limit percentage of any budget, below the hard limit", () => {
    const soft = evaluate([
      { scope: "key", limitUsd: "100", spentUsd: "10" },
      { scope: "team", limitUsd: "10", spentUsd: "8" },
    ]);
    expect(soft.decision).toBe("soft");
    expect(soft.soft).toEqual(["team"]);
    expect(soft.headers["x-switchyard-budget-warning"]).toBe("soft_limit_reached");
    expect(evaluate([{ scope: "key", limitUsd: "10", spentUsd: "7.9999" }]).decision).toBe("allow");
    expect(evaluate([{ scope: "key", limitUsd: "10", spentUsd: "9" }], 95).decision).toBe("allow");
    expect(evaluate([{ scope: "key", limitUsd: "10", spentUsd: "0" }], 100).decision).toBe("allow");
    expect(evaluate([{ scope: "key", limitUsd: "10", spentUsd: "10" }]).headers).not.toHaveProperty(
      "x-switchyard-budget-warning",
    );
  });
});

describe("createBudgetCheck (spec 007)", () => {
  let metrics: ReturnType<typeof installTestMetrics>;
  let tracing: ReturnType<typeof installInMemoryTracing>;
  beforeEach(() => {
    metrics = installTestMetrics();
    tracing = installInMemoryTracing();
  });
  afterEach(async () => {
    await metrics.uninstall();
    await tracing.uninstall();
  });

  const principal = (budget: Principal["budget"]): Principal => ({
    keyId: "key-1",
    teamId: "team-1",
    allowedModels: null,
    keyLimits: { rpm: null, tpm: null },
    teamLimits: { rpm: null, tpm: null },
    ...(budget ? { budget } : {}),
  });

  function setup(onRedisError: "open" | "closed" = "closed") {
    const counters = new MemoryBudgetCounters({ now: () => now });
    const logs = captureLogs();
    let now = NOW;
    const check = createBudgetCheck({
      counters,
      config: { onRedisError },
      logger: createLogger({ level: "info", destination: logs.stream }),
      now: () => now,
    });
    return {
      check,
      counters,
      logs: logs.lines,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const spans = () =>
    tracing.exporter.getFinishedSpans().filter((s) => s.name === "switchyard.budget");

  it("does not read counters when neither the key nor the team has a budget", async () => {
    const { check, counters } = setup();
    counters.failing = true;
    expect(await check.check(principal(undefined))).toEqual({ headers: {} });
    expect(await check.check(principal({ keyUsd: null, teamUsd: null, softLimitPct: 80 }))).toEqual(
      { headers: {} },
    );
    expect(spans()).toHaveLength(0);
  });

  it("admits with headers and an allow span", async () => {
    const { check, counters } = setup();
    await counters.charge("2026-10", [{ scope: "key", id: "key-1" }], "2.5", EXPIRY);
    const result = await check.check(principal({ keyUsd: "10", teamUsd: null, softLimitPct: 80 }));
    expect(result.headers).toEqual({
      "x-switchyard-budget-limit-usd": "10",
      "x-switchyard-budget-remaining-usd": "7.5",
      "x-switchyard-budget-reset": RESET,
    });
    expect(spans()[0]?.attributes).toEqual({
      "switchyard.budget.scope": "key",
      "switchyard.budget.decision": "allow",
    });
  });

  it("rejects with 429 insufficient_quota naming the scope and reset, never amounts", async () => {
    const { check, counters } = setup();
    await counters.charge("2026-10", [{ scope: "team", id: "team-1" }], "50", EXPIRY);
    const error = await check
      .check(principal({ keyUsd: "10", teamUsd: "50", softLimitPct: 80 }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    const gatewayError = error as GatewayError;
    expect(gatewayError.status).toBe(429);
    expect(gatewayError.type).toBe("insufficient_quota");
    expect(gatewayError.code).toBe("budget_exceeded");
    expect(gatewayError.retryable).toBe(false);
    expect(gatewayError.message).toBe(
      `Monthly budget exhausted for this team. It resets at ${RESET}.`,
    );
    expect(gatewayError.headers).toEqual({
      "x-should-retry": "false",
      "x-switchyard-budget-limit-usd": "50",
      "x-switchyard-budget-remaining-usd": "0",
      "x-switchyard-budget-reset": RESET,
    });
    expect(spans()[0]?.attributes).toMatchObject({
      "switchyard.budget.scope": "team",
      "switchyard.budget.decision": "reject",
    });
    expect(await metrics.points("switchyard_budget_rejections_total")).toEqual([
      expect.objectContaining({ attributes: { scope: "team" }, value: 1 }),
    ]);
  });

  it("counts soft-limit requests per scope and logs once per scope, id and period", async () => {
    const { check, counters, logs, advance } = setup();
    const p = principal({ keyUsd: "10", teamUsd: "10", softLimitPct: 80 });
    await counters.charge(
      "2026-10",
      [
        { scope: "key", id: "key-1" },
        { scope: "team", id: "team-1" },
      ],
      "9",
      EXPIRY,
    );
    for (let i = 0; i < 3; i += 1) {
      const { headers } = await check.check(p);
      expect(headers["x-switchyard-budget-warning"]).toBe("soft_limit_reached");
    }
    expect(await metrics.points("switchyard_budget_soft_limit_requests_total")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: { scope: "key" }, value: 3 }),
        expect.objectContaining({ attributes: { scope: "team" }, value: 3 }),
      ]),
    );
    const warnings = () => logs.filter((l) => l.msg === "budget soft limit reached");
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toMatchObject({
      level: "warn",
      scope: "key",
      id: "key-1",
      period: "2026-10",
    });
    expect(spans()[0]?.attributes["switchyard.budget.decision"]).toBe("soft");

    // A new period starts from zero: no warning, and the next crossing warns again.
    advance(Date.parse("2026-11-01T00:00:00Z") - NOW);
    expect((await check.check(p)).headers["x-switchyard-budget-warning"]).toBeUndefined();
    await counters.charge(
      "2026-11",
      [{ scope: "key", id: "key-1" }],
      "8",
      EXPIRY + 31 * 86_400_000,
    );
    await check.check(p);
    expect(warnings()).toHaveLength(3);
  });

  it("fails closed with 503 budget_unavailable when the counters are unreachable", async () => {
    const { check, counters } = setup("closed");
    counters.failing = true;
    const error = await check
      .check(principal({ keyUsd: "10", teamUsd: null, softLimitPct: 80 }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: "budget_unavailable" });
    expect(spans()[0]?.attributes["switchyard.budget.decision"]).toBe("fail_closed");
  });

  it("fails open when configured: admits without headers, counts it, warns once a minute", async () => {
    const { check, counters, logs, advance } = setup("open");
    counters.failing = true;
    const p = principal({ keyUsd: "10", teamUsd: null, softLimitPct: 80 });
    expect(await check.check(p)).toEqual({ headers: {} });
    expect(await check.check(p)).toEqual({ headers: {} });
    advance(60_000);
    await check.check(p);
    expect(
      logs.filter((l) => l.msg === "budget counters unavailable, admitting requests"),
    ).toHaveLength(2);
    expect(await metrics.points("switchyard_budget_fail_open_total")).toEqual([
      expect.objectContaining({ value: 3 }),
    ]);
    expect(spans()[0]?.attributes["switchyard.budget.decision"]).toBe("fail_open");
  });

  it("puts no ids or key material in the span", async () => {
    const { check } = setup();
    await check.check(principal({ keyUsd: "10", teamUsd: "20", softLimitPct: 80 }));
    const attributes = JSON.stringify(spans().map((s) => s.attributes));
    expect(attributes).not.toContain("key-1");
    expect(attributes).not.toContain("team-1");
  });
});
