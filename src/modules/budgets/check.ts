/**
 * Budget admission (spec 007, AC-6..AC-9, AC-11, AC-13): runs before rate limiting, compares the
 * current spend with the budgets of the key and its team, and never reserves a cost (ADR-0017).
 */
import { type Span, trace } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import type { Principal } from "../../core/auth.js";
import type { BudgetCounters, BudgetRef, BudgetScope } from "../../core/budget.js";
import { budgetExceeded, budgetUnavailable } from "../../core/errors.js";
import {
  compare,
  type Decimal,
  decimal,
  mulInt,
  normalize,
  round,
  shift,
  sub,
} from "../pricing/decimal.js";
import type { RatioGauge } from "./gauge.js";
import { periodOf } from "./period.js";
import { budgetMetrics } from "./telemetry.js";

export type BudgetDecision = "allow" | "soft" | "reject" | "fail_open" | "fail_closed";

export interface ScopeSpend {
  scope: BudgetScope;
  limitUsd: string;
  spentUsd: string;
}

export interface BudgetEvaluation {
  decision: "allow" | "soft" | "reject";
  /** The rejected scope, else the one with the lowest remaining budget (headers describe it). */
  scope: BudgetScope;
  /** Scopes at or past their soft limit (and below the hard limit). */
  soft: BudgetScope[];
  headers: Record<string, string>;
}

/** Spend is compared at 10 decimal places: the Redis counter is a float (ADR-0017). */
const SPEND_SCALE = 10;
const ZERO: Decimal = { units: 0n, scale: 0 };

/**
 * Pure decision for the scopes that have a budget (key first, then team). Rejects when spend is
 * at or above a budget (the key first); otherwise describes the scope with the lowest remaining
 * budget and flags scopes at or above `softLimitPct` percent of theirs.
 */
export function evaluateBudgets(input: {
  scopes: readonly ScopeSpend[];
  softLimitPct: number;
  resetAt: string;
}): BudgetEvaluation {
  const items = input.scopes.map((s) => {
    const limit = decimal(s.limitUsd);
    const spent = round(decimal(s.spentUsd), SPEND_SCALE);
    const left = sub(limit, spent);
    const remaining = compare(left, ZERO) > 0 ? left : ZERO;
    const hard = compare(spent, limit) >= 0;
    const softLimit = shift(mulInt(limit, input.softLimitPct), 2);
    return {
      scope: s.scope,
      limit,
      remaining,
      hard,
      soft: !hard && compare(spent, softLimit) >= 0,
    };
  });
  const [first] = items;
  if (!first) throw new RangeError("evaluateBudgets needs at least one scope");

  const rejected = items.find((item) => item.hard);
  const described =
    rejected ??
    items.reduce((best, item) => (compare(item.remaining, best.remaining) < 0 ? item : best));
  const soft = rejected ? [] : items.filter((item) => item.soft).map((item) => item.scope);

  const headers: Record<string, string> = {
    "x-switchyard-budget-limit-usd": normalize(described.limit),
    "x-switchyard-budget-remaining-usd": normalize(described.remaining),
    "x-switchyard-budget-reset": input.resetAt,
  };
  if (soft.length > 0) headers["x-switchyard-budget-warning"] = "soft_limit_reached";
  return {
    decision: rejected ? "reject" : soft.length > 0 ? "soft" : "allow",
    scope: described.scope,
    soft,
    headers,
  };
}

export interface BudgetCheckDeps {
  counters: BudgetCounters;
  config: { onRedisError: "open" | "closed" };
  logger: FastifyBaseLogger;
  /** Ratio gauge fed with each budgeted scope's spend (AC-13). */
  gauge?: RatioGauge;
  now?: () => number;
}

export interface BudgetCheck {
  /** Headers for the response; throws 429 `budget_exceeded` or 503 `budget_unavailable`. */
  check(principal: Principal): Promise<{ headers: Record<string, string> }>;
}

const WARN_INTERVAL_MS = 60_000;
const MAX_WARNED = 10_000;
const NO_HEADERS = { headers: {} };

export function createBudgetCheck(deps: BudgetCheckDeps): BudgetCheck {
  const now = deps.now ?? Date.now;
  const tracer = () => trace.getTracer("switchyard");
  let lastFailOpenWarning = Number.NEGATIVE_INFINITY;
  /** `${period}:${scope}:${id}` already warned about on this instance. */
  const warned = new Set<string>();
  let warnedPeriod = "";

  const end = (span: Span, decision: BudgetDecision, scope?: BudgetScope) => {
    span.setAttributes({
      ...(scope ? { "switchyard.budget.scope": scope } : {}),
      "switchyard.budget.decision": decision,
    });
    span.end();
  };

  function warnSoft(period: string, ref: BudgetRef) {
    if (warnedPeriod !== period || warned.size >= MAX_WARNED) {
      warned.clear();
      warnedPeriod = period;
    }
    const id = `${period}:${ref.scope}:${ref.id}`;
    if (warned.has(id)) return;
    warned.add(id);
    deps.logger.warn({ scope: ref.scope, id: ref.id, period }, "budget soft limit reached");
  }

  return {
    async check(principal) {
      const budget = principal.budget;
      const key: BudgetRef = { scope: "key", id: principal.keyId };
      const team: BudgetRef = { scope: "team", id: principal.teamId };
      const budgeted: { ref: BudgetRef; limitUsd: string }[] = [];
      for (const [ref, limitUsd] of [
        [key, budget?.keyUsd ?? null],
        [team, budget?.teamUsd ?? null],
      ] as const) {
        if (limitUsd === null) deps.gauge?.forget(ref);
        else budgeted.push({ ref, limitUsd });
      }
      // No budget: Redis is never consulted, so these requests never depend on it (AC-11).
      if (budgeted.length === 0 || !budget) return NO_HEADERS;

      const period = periodOf(now());
      const span = tracer().startSpan("switchyard.budget");
      let spent: string[];
      try {
        spent = await deps.counters.read(
          period.id,
          budgeted.map((b) => b.ref),
        );
        for (const value of spent) decimal(value); // a corrupt counter counts as unavailable
      } catch (error) {
        if (deps.config.onRedisError === "closed") {
          end(span, "fail_closed");
          throw budgetUnavailable();
        }
        budgetMetrics.failOpen();
        if (now() - lastFailOpenWarning >= WARN_INTERVAL_MS) {
          lastFailOpenWarning = now();
          deps.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "budget counters unavailable, admitting requests",
          );
        }
        end(span, "fail_open");
        return NO_HEADERS;
      }

      budgeted.forEach((b, i) => {
        deps.gauge?.track(b.ref, b.limitUsd, period.id, spent[i] ?? "0");
      });
      const result = evaluateBudgets({
        scopes: budgeted.map((b, i) => ({
          scope: b.ref.scope,
          limitUsd: b.limitUsd,
          spentUsd: spent[i] ?? "0",
        })),
        softLimitPct: budget.softLimitPct,
        resetAt: period.end,
      });
      end(span, result.decision, result.scope);

      if (result.decision === "reject") {
        budgetMetrics.rejected(result.scope);
        throw budgetExceeded(result.scope, period.end, {
          "x-should-retry": "false",
          ...result.headers,
        });
      }
      for (const scope of result.soft) {
        budgetMetrics.softLimit(scope);
        warnSoft(period.id, scope === "key" ? key : team);
      }
      return { headers: result.headers };
    },
  };
}
