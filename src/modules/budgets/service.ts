/** Composition of the gateway side of budgets (spec 007): admission check, charger and gauge. */
import type { FastifyBaseLogger } from "fastify";
import type { BudgetsConfig } from "../../config/schema.js";
import type { BudgetCounters } from "../../core/budget.js";
import type { OutcomeRecorder } from "../../core/usage.js";
import { createBudgetCharger } from "./charge.js";
import { type BudgetCheck, createBudgetCheck } from "./check.js";
import { createRatioGauge } from "./gauge.js";

export interface Budgets {
  check: BudgetCheck;
  /** Outcome recorder: cost metrics and counter charges. */
  charger: OutcomeRecorder;
  /** Stops reporting the ratio gauge (app close). */
  close(): void;
}

export function createBudgets(deps: {
  counters: BudgetCounters;
  config: BudgetsConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}): Budgets {
  const gauge = createRatioGauge(deps.now ? { now: deps.now } : {});
  return {
    check: createBudgetCheck({
      counters: deps.counters,
      config: deps.config,
      logger: deps.logger,
      gauge,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    charger: createBudgetCharger({
      counters: deps.counters,
      logger: deps.logger,
      gauge,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    close: () => gauge.close(),
  };
}
