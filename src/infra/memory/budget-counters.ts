import type { BudgetCounters, BudgetRef } from "../../core/budget.js";
import { add, compare, decimal, normalize } from "../../modules/pricing/decimal.js";

interface Stored {
  value: string;
  expireAt: number;
}

/**
 * In-process budget counters with the semantics of the Redis implementation (spec 007), in exact
 * decimals. Used by unit and contract tests, and by `buildApp` when no counters are injected.
 */
export class MemoryBudgetCounters implements BudgetCounters {
  readonly #counters = new Map<string, Stored>();
  readonly #now: () => number;
  /** When true every call rejects, like an unreachable Redis. */
  failing = false;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #key(period: string, ref: BudgetRef) {
    return `${period}:${ref.scope}:${ref.id}`;
  }

  #get(key: string): string {
    const stored = this.#counters.get(key);
    if (!stored || stored.expireAt <= this.#now()) return "0";
    return stored.value;
  }

  #check() {
    if (this.failing) return Promise.reject(new Error("budget counters unavailable"));
    return undefined;
  }

  async read(period: string, refs: readonly BudgetRef[]): Promise<string[]> {
    await this.#check();
    return refs.map((ref) => this.#get(this.#key(period, ref)));
  }

  async charge(
    period: string,
    refs: readonly BudgetRef[],
    amountUsd: string,
    expireAtMs: number,
  ): Promise<string[]> {
    await this.#check();
    return refs.map((ref) => {
      const key = this.#key(period, ref);
      const value = normalize(add(decimal(this.#get(key)), decimal(amountUsd)));
      this.#counters.set(key, { value, expireAt: expireAtMs });
      return value;
    });
  }

  async raise(
    period: string,
    entries: readonly { ref: BudgetRef; spentUsd: string }[],
    expireAtMs: number,
  ): Promise<number> {
    await this.#check();
    let raised = 0;
    for (const { ref, spentUsd } of entries) {
      const key = this.#key(period, ref);
      if (compare(decimal(this.#get(key)), decimal(spentUsd)) < 0) {
        this.#counters.set(key, { value: normalize(decimal(spentUsd)), expireAt: expireAtMs });
        raised += 1;
      }
    }
    return raised;
  }
}
