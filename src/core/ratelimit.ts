/** One token bucket to debit: `capacity` units per minute, refilled continuously (spec 005). */
export interface BucketSpec {
  key: string;
  capacity: number;
  cost: number;
}

export interface BucketState {
  key: string;
  capacity: number;
  /** Units left after this call (may be negative after a charge). */
  remaining: number;
  /** Milliseconds until the bucket is full again. */
  resetMs: number;
}

export interface TakeResult {
  allowed: boolean;
  buckets: BucketState[];
  /** When rejected: ms until every bucket could cover its cost. 0 when allowed. */
  retryAfterMs: number;
}

export interface BucketAdjustment {
  key: string;
  capacity: number;
  /** Positive refunds units (capped at capacity); negative charges (no floor). */
  delta: number;
}

/** Shared, atomic per-minute limiter. Implemented on Redis + Lua in production (ADR-0006). */
export interface RateLimiter {
  /** All-or-nothing: debits every bucket or none. */
  take(buckets: BucketSpec[]): Promise<TakeResult>;
  adjust(adjustments: BucketAdjustment[]): Promise<void>;
  /** Units currently available, without debiting. */
  peek(key: string, capacity: number): Promise<number>;
}
