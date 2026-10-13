/**
 * The budget charger (spec 007, AC-3/AC-10): an `OutcomeRecorder` composed with the usage
 * publisher. It counts each event's cost and adds known costs to the Redis budget counters.
 */
import { trace } from "@opentelemetry/api";
import type { OutcomeRecorder } from "../../core/usage.js";
import { budgetMetrics } from "./telemetry.js";

export function createBudgetCharger(): OutcomeRecorder {
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
    },
  };
}
