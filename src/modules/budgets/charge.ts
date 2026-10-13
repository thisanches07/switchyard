/**
 * The budget charger (spec 007, AC-3/AC-10/AC-11/AC-13): an `OutcomeRecorder` composed with the
 * usage publisher. It counts each event's cost and adds known costs to the key's and the team's
 * Redis counters of the event's period, in the background: a failure never touches the response
 * and is repaired by the worker's reconciliation.
 */
import { trace } from "@opentelemetry/api";
import type { FastifyBaseLogger } from "fastify";
import type { BudgetCounters, BudgetRef } from "../../core/budget.js";
import type { OutcomeRecorder } from "../../core/usage.js";
import type { RatioGauge } from "./gauge.js";
import { counterExpiry, periodOf } from "./period.js";
import { budgetMetrics } from "./telemetry.js";

export interface BudgetChargerDeps {
  counters: BudgetCounters;
  logger: FastifyBaseLogger;
  gauge?: RatioGauge;
  now?: () => number;
}

const WARN_INTERVAL_MS = 60_000;

export function createBudgetCharger(deps: BudgetChargerDeps): OutcomeRecorder {
  const now = deps.now ?? Date.now;
  let lastWarning = Number.NEGATIVE_INFINITY;

  function failed(error: unknown, event: { requestId: string; keyId: string; teamId: string }) {
    budgetMetrics.chargeFailed();
    if (now() - lastWarning < WARN_INTERVAL_MS) return;
    lastWarning = now();
    deps.logger.warn(
      {
        requestId: event.requestId,
        keyId: event.keyId,
        teamId: event.teamId,
        err: error instanceof Error ? error.message : String(error),
      },
      "budget counters could not be charged",
    );
  }

  return {
    record(event) {
      if (event.provider === null || event.servedModel === null) return;
      if (event.costUsd === null) {
        budgetMetrics.unknownCost(event.provider, event.servedModel);
        return;
      }
      const usd = Number(event.costUsd);
      budgetMetrics.cost(event.provider, event.servedModel, usd);
      trace.getActiveSpan()?.setAttribute("switchyard.cost_usd", usd);
      if (!(usd > 0)) return;

      const period = periodOf(Date.parse(event.occurredAt));
      const refs: BudgetRef[] = [
        { scope: "key", id: event.keyId },
        { scope: "team", id: event.teamId },
      ];
      deps.counters.charge(period.id, refs, event.costUsd, counterExpiry(period)).then(
        (totals) => {
          refs.forEach((ref, i) => {
            deps.gauge?.charged(ref, period.id, totals[i] ?? "0");
          });
        },
        (error: unknown) => failed(error, event),
      );
    },
  };
}
