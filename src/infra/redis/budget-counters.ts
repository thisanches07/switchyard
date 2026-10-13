import type { Redis } from "ioredis";
import type { BudgetCounters, BudgetRef } from "../../core/budget.js";

/*
 * Budget counters in Redis (spec 007, ADR-0006/0017): one float per period and scope,
 * `sy:budget:{YYYY-MM}:{key|team}:{id}`, incremented with INCRBYFLOAT after each request and
 * raised (never lowered) by the worker's reconciliation. Counters expire after their period.
 */

/** KEYS: counters. ARGV[1]: amount, ARGV[2]: expiry (ms). Returns the new totals. */
const CHARGE = `
local out = {}
for i = 1, #KEYS do
  out[i] = redis.call('INCRBYFLOAT', KEYS[i], ARGV[1])
  redis.call('PEXPIREAT', KEYS[i], ARGV[2])
end
return out
`;

/** KEYS: counters. ARGV[1]: expiry (ms), ARGV[i + 1]: value for KEYS[i]. Returns how many rose. */
const RAISE = `
local raised = 0
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  if current < tonumber(ARGV[i + 1]) then
    redis.call('SET', KEYS[i], ARGV[i + 1])
    redis.call('PEXPIREAT', KEYS[i], ARGV[1])
    raised = raised + 1
  end
end
return raised
`;

/** Keys per script call when raising many counters. */
const BATCH = 500;

type ScriptRedis = Redis & {
  syBudgetCharge(numKeys: number, ...args: (string | number)[]): Promise<string[]>;
  syBudgetRaise(numKeys: number, ...args: (string | number)[]): Promise<number>;
};

export interface RedisBudgetCountersOptions {
  /** Per-call deadline; on expiry the call rejects and `budgets.onRedisError` applies. */
  timeoutMs?: number;
}

export class RedisBudgetCounters implements BudgetCounters {
  readonly #redis: ScriptRedis;
  readonly #timeoutMs: number;

  constructor(redis: Redis, options: RedisBudgetCountersOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 200;
    if (!("syBudgetCharge" in redis)) {
      redis.defineCommand("syBudgetCharge", { lua: CHARGE });
      redis.defineCommand("syBudgetRaise", { lua: RAISE });
    }
    this.#redis = redis as ScriptRedis;
  }

  static key(period: string, ref: BudgetRef): string {
    return `sy:budget:${period}:${ref.scope}:${ref.id}`;
  }

  async read(period: string, refs: readonly BudgetRef[]): Promise<string[]> {
    if (refs.length === 0) return [];
    const values = await this.#deadline(
      this.#redis.mget(...refs.map((ref) => RedisBudgetCounters.key(period, ref))),
    );
    return values.map((value) => value ?? "0");
  }

  async charge(
    period: string,
    refs: readonly BudgetRef[],
    amountUsd: string,
    expireAtMs: number,
  ): Promise<string[]> {
    if (refs.length === 0) return [];
    const totals = await this.#deadline(
      this.#redis.syBudgetCharge(
        refs.length,
        ...refs.map((ref) => RedisBudgetCounters.key(period, ref)),
        amountUsd,
        expireAtMs,
      ),
    );
    return totals.map(String);
  }

  async raise(
    period: string,
    entries: readonly { ref: BudgetRef; spentUsd: string }[],
    expireAtMs: number,
  ): Promise<number> {
    let raised = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      raised += Number(
        await this.#deadline(
          this.#redis.syBudgetRaise(
            batch.length,
            ...batch.map((e) => RedisBudgetCounters.key(period, e.ref)),
            expireAtMs,
            ...batch.map((e) => e.spentUsd),
          ),
        ),
      );
    }
    return raised;
  }

  #deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`budget counters timed out after ${this.#timeoutMs} ms`)),
        this.#timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
