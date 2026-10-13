import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";

function limiter() {
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  return { limiter: new MemoryRateLimiter({ now: () => now }), clock };
}

const req = (capacity: number, cost = 1) => ({ key: "k:req", capacity, cost });
const tok = (capacity: number, cost: number) => ({ key: "k:tok", capacity, cost });

describe("MemoryRateLimiter (token bucket reference)", () => {
  it("starts full and debits until empty", async () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < 3; i += 1) expect((await l.take([req(3)])).allowed).toBe(true);
    const rejected = await l.take([req(3)]);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeCloseTo(20_000); // 1 unit at 3/min
  });

  it("is all-or-nothing across buckets", async () => {
    const { limiter: l } = limiter();
    await l.take([tok(100, 90)]);
    const result = await l.take([req(10), tok(100, 20)]);
    expect(result.allowed).toBe(false);
    expect(await l.peek("k:req", 10)).toBe(10); // request bucket untouched
    expect(result.buckets.map((b) => Math.round(b.remaining))).toEqual([10, 10]);
  });

  it("refills continuously at capacity per minute", async () => {
    const { limiter: l, clock } = limiter();
    await l.take([req(60, 60)]);
    clock.advance(1_000);
    expect(await l.peek("k:req", 60)).toBeCloseTo(1);
    clock.advance(120_000);
    expect(await l.peek("k:req", 60)).toBe(60); // capped at capacity
  });

  it("reports remaining and time to full", async () => {
    const { limiter: l } = limiter();
    const result = await l.take([req(60, 15)]);
    expect(result.buckets[0]).toMatchObject({ remaining: 45, resetMs: 15_000 });
  });

  it("adjust refunds up to capacity and charges below zero", async () => {
    const { limiter: l } = limiter();
    await l.take([tok(1_000, 600)]);
    await l.adjust([{ key: "k:tok", capacity: 1_000, delta: 900 }]);
    expect(await l.peek("k:tok", 1_000)).toBe(1_000);
    await l.adjust([{ key: "k:tok", capacity: 1_000, delta: -1_500 }]);
    expect(await l.peek("k:tok", 1_000)).toBe(-500);
    expect((await l.take([tok(1_000, 1)])).allowed).toBe(false);
  });

  it("peek does not debit", async () => {
    const { limiter: l } = limiter();
    expect(await l.peek("k:req", 5)).toBe(5);
    expect(await l.peek("k:req", 5)).toBe(5);
  });
});
