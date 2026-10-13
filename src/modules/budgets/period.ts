/** Budget periods: calendar months in UTC (spec 007, AC-5; ADR-0017). Pure. */

export interface BudgetPeriod {
  /** `YYYY-MM`, part of the counter keys. */
  id: string;
  /** ISO-8601 UTC instants: start inclusive, end exclusive (the reset time). */
  start: string;
  end: string;
  /** UTC dates (`YYYY-MM-DD`) of start and end, for `usage_daily.day` ranges. */
  startDay: string;
  endDay: string;
  startMs: number;
  endMs: number;
}

/** Counters outlive their period by a week, so late events of the old month are still charged. */
const COUNTER_GRACE_MS = 7 * 86_400_000;

/** The period containing the instant `ms`. */
export function periodOf(ms: number): BudgetPeriod {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const startMs = Date.UTC(year, month, 1);
  const endMs = Date.UTC(year, month + 1, 1);
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  return {
    id: start.slice(0, 7),
    start,
    end,
    startDay: start.slice(0, 10),
    endDay: end.slice(0, 10),
    startMs,
    endMs,
  };
}

/** When the counters of a period expire. */
export function counterExpiry(period: BudgetPeriod): number {
  return period.endMs + COUNTER_GRACE_MS;
}
