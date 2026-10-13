/** Cost and budget metrics (spec 007, AC-3/AC-6/AC-9/AC-11/AC-13). Names are fixed in waves.md. */
import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api";
import type { BudgetScope } from "../../core/budget.js";

interface Instruments {
  provider: MeterProvider;
  cost: Counter;
  unknownCost: Counter;
  rejections: Counter;
  softLimit: Counter;
  failOpen: Counter;
  chargeFailures: Counter;
}
let instruments: Instruments | undefined;

/** Ratio sources for `switchyard_budget_used_ratio`; each reports its own series. */
const ratioSources = new Set<() => Iterable<{ scope: BudgetScope; id: string; ratio: number }>>();

/** Instruments are bound to the current global MeterProvider (tests may swap it). */
function getInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    meter
      .createObservableGauge("switchyard_budget_used_ratio", {
        description: "Current-period spend divided by the monthly budget (may exceed 1)",
      })
      .addCallback((result) => {
        for (const source of ratioSources) {
          for (const { scope, id, ratio } of source()) result.observe(ratio, { scope, id });
        }
      });
    instruments = {
      provider,
      cost: meter.createCounter("switchyard_cost_usd_total", {
        description: "Known cost of requests in USD, by provider and served model",
        unit: "USD",
      }),
      unknownCost: meter.createCounter("switchyard_cost_unknown_requests_total", {
        description: "Requests whose cost is unknown (no price, or a TODO price)",
      }),
      rejections: meter.createCounter("switchyard_budget_rejections_total", {
        description: "Requests rejected because a monthly budget is exhausted, by scope",
      }),
      softLimit: meter.createCounter("switchyard_budget_soft_limit_requests_total", {
        description: "Admitted requests past the soft limit of a budget, by scope",
      }),
      failOpen: meter.createCounter("switchyard_budget_fail_open_total", {
        description: "Requests admitted without a budget check because Redis was unavailable",
      }),
      chargeFailures: meter.createCounter("switchyard_budget_charge_failures_total", {
        description: "Request costs that could not be added to the Redis budget counters",
      }),
    };
  }
  return instruments;
}

export const budgetMetrics = {
  cost(provider: string, model: string, usd: number) {
    getInstruments().cost.add(usd, { provider, model });
  },
  unknownCost(provider: string, model: string) {
    getInstruments().unknownCost.add(1, { provider, model });
  },
  rejected(scope: BudgetScope) {
    getInstruments().rejections.add(1, { scope });
  },
  softLimit(scope: BudgetScope) {
    getInstruments().softLimit.add(1, { scope });
  },
  failOpen() {
    getInstruments().failOpen.add(1);
  },
  chargeFailed() {
    getInstruments().chargeFailures.add(1);
  },
  /** Reports used ratios through the gauge until the returned function is called. */
  watchRatios(
    source: () => Iterable<{ scope: BudgetScope; id: string; ratio: number }>,
  ): () => void {
    getInstruments();
    ratioSources.add(source);
    return () => {
      ratioSources.delete(source);
    };
  },
};
