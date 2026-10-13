/** `GET /admin/usage` query handling (spec 006, AC-11): pure parsing and formatting. */
import { z } from "zod";
import { invalidRequest } from "../../core/errors.js";
import { USAGE_GROUP_BY, type UsageQuery } from "../../core/usage.js";
import { parseWith } from "../validation.js";

const DAY_MS = 86_400_000;
const DEFAULT_SPAN_DAYS = 29; // from = to − 29 days: 30 days, both inclusive
const MAX_SPAN_DAYS = 366;

const querySchema = z.object({
  from: z.iso.date("must be a UTC date (YYYY-MM-DD)").optional(),
  to: z.iso.date("must be a UTC date (YYYY-MM-DD)").optional(),
  groupBy: z.enum(USAGE_GROUP_BY).default("day"),
  teamId: z.uuid().optional(),
  keyId: z.uuid().optional(),
});

const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Today's date in UTC (`YYYY-MM-DD`). */
export function todayUtc(now: number = Date.now()): string {
  return toDay(now);
}

/** Validates the query and applies the defaults; throws a 400 `invalid_request`. */
export function parseUsageQuery(raw: unknown, today: string): UsageQuery {
  const parsed = parseWith(querySchema, raw);
  const to = parsed.to ?? today;
  const from = parsed.from ?? toDay(dayMs(to) - DEFAULT_SPAN_DAYS * DAY_MS);
  if (dayMs(from) > dayMs(to)) throw invalidRequest("from: must not be after to");
  if ((dayMs(to) - dayMs(from)) / DAY_MS > MAX_SPAN_DAYS) {
    throw invalidRequest(`from: the range must not exceed ${MAX_SPAN_DAYS} days`);
  }
  return {
    from,
    to,
    groupBy: parsed.groupBy,
    ...(parsed.teamId ? { teamId: parsed.teamId } : {}),
    ...(parsed.keyId ? { keyId: parsed.keyId } : {}),
  };
}

/** Drops trailing zeros of a decimal string from Postgres: "1.500" → "1.5", "0.000" → "0". */
export function normalizeDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "") || "0";
}
