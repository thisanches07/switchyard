import type { Redis } from "ioredis";
import type {
  BucketAdjustment,
  BucketSpec,
  RateLimiter,
  TakeResult,
} from "../../core/ratelimit.js";

/*
 * Token buckets in Redis (spec 005, ADR-0006). Each bucket is a hash { tokens, ts } refilled
 * continuously at capacity/60000 per ms, using the Redis clock (TIME) so gateway instances
 * never disagree. Floats travel as strings: Lua numbers returned directly would be truncated.
 * Keys expire once they would be full again (plus a minute), so idle buckets cost nothing.
 */

const REFILL = `
local function now_ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function level(key, cap, now)
  local data = redis.call('HMGET', key, 'tokens', 'ts')
  if not data[1] then return cap end
  local elapsed = math.max(0, now - tonumber(data[2]))
  return math.min(cap, tonumber(data[1]) + elapsed * cap / 60000)
end
local function store(key, cap, tokens, now)
  redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
  local to_full = math.max(0, (cap - tokens) * 60000 / cap)
  redis.call('PEXPIRE', key, math.ceil(to_full) + 60000)
end
`;

/** KEYS: buckets. ARGV: capacity, cost pairs. Returns { allowed, retryAfterMs, remaining... }. */
const TAKE = `${REFILL}
local now = now_ms()
local n = #KEYS
local levels = {}
local allowed = 1
for i = 1, n do
  local cap = tonumber(ARGV[2 * i - 1])
  levels[i] = level(KEYS[i], cap, now)
  if levels[i] < tonumber(ARGV[2 * i]) then allowed = 0 end
end
local retry = 0
local out = { allowed, '0' }
for i = 1, n do
  local cap = tonumber(ARGV[2 * i - 1])
  local cost = tonumber(ARGV[2 * i])
  local remaining = levels[i]
  if allowed == 1 then remaining = levels[i] - cost end
  store(KEYS[i], cap, remaining, now)
  if allowed == 0 and levels[i] < cost then
    retry = math.max(retry, (cost - levels[i]) * 60000 / cap)
  end
  out[i + 2] = tostring(remaining)
end
out[2] = tostring(retry)
return out
`;

/** KEYS: buckets. ARGV: capacity, delta pairs. Refund capped at capacity; charges have no floor. */
const ADJUST = `${REFILL}
local now = now_ms()
for i = 1, #KEYS do
  local cap = tonumber(ARGV[2 * i - 1])
  local tokens = math.min(cap, level(KEYS[i], cap, now) + tonumber(ARGV[2 * i]))
  store(KEYS[i], cap, tokens, now)
end
return 1
`;

/** KEYS[1]: bucket. ARGV[1]: capacity. Current level without writing. */
const PEEK = `${REFILL}
return tostring(level(KEYS[1], tonumber(ARGV[1]), now_ms()))
`;

type ScriptRedis = Redis & {
  syRateTake(numKeys: number, ...args: (string | number)[]): Promise<[number, string, ...string[]]>;
  syRateAdjust(numKeys: number, ...args: (string | number)[]): Promise<number>;
  syRatePeek(key: string, capacity: number): Promise<string>;
};

export interface RedisRateLimiterOptions {
  /** Per-call deadline; on expiry the call rejects and the admission policy applies (spec 005, AC-10). */
  timeoutMs?: number;
}

export class RedisRateLimiter implements RateLimiter {
  readonly #redis: ScriptRedis;
  readonly #timeoutMs: number;

  constructor(redis: Redis, options: RedisRateLimiterOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 200;
    // EVALSHA with automatic EVAL fallback (scripts are cached by Redis after first use).
    if (!("syRateTake" in redis)) {
      redis.defineCommand("syRateTake", { lua: TAKE });
      redis.defineCommand("syRateAdjust", { lua: ADJUST });
      redis.defineCommand("syRatePeek", { lua: PEEK, numberOfKeys: 1 });
    }
    this.#redis = redis as ScriptRedis;
  }

  async take(buckets: BucketSpec[]): Promise<TakeResult> {
    if (buckets.length === 0) return { allowed: true, buckets: [], retryAfterMs: 0 };
    const args = buckets.flatMap((b) => [b.capacity, b.cost]);
    const reply = await this.#deadline(
      this.#redis.syRateTake(buckets.length, ...buckets.map((b) => b.key), ...args),
    );
    const [allowed, retry, ...remaining] = reply;
    return {
      allowed: Number(allowed) === 1,
      retryAfterMs: Number(retry),
      buckets: buckets.map((b, i) => {
        const left = Number(remaining[i]);
        return {
          key: b.key,
          capacity: b.capacity,
          remaining: left,
          resetMs: Math.max(0, ((b.capacity - left) * 60_000) / b.capacity),
        };
      }),
    };
  }

  async adjust(adjustments: BucketAdjustment[]): Promise<void> {
    const changes = adjustments.filter((a) => a.delta !== 0);
    if (changes.length === 0) return;
    await this.#deadline(
      this.#redis.syRateAdjust(
        changes.length,
        ...changes.map((a) => a.key),
        ...changes.flatMap((a) => [a.capacity, a.delta]),
      ),
    );
  }

  async peek(key: string, capacity: number): Promise<number> {
    return Number(await this.#deadline(this.#redis.syRatePeek(key, capacity)));
  }

  #deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`rate limiter timed out after ${this.#timeoutMs} ms`)),
        this.#timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
