import { describe, expect, it } from "vitest";
import { type BreakerTransition, CircuitBreaker } from "../../../src/modules/routing/breaker.js";

const settings = { failureThreshold: 3, openMs: 1_000 };

function setup() {
  const transitions: BreakerTransition[] = [];
  const breaker = new CircuitBreaker(
    () => settings,
    (t) => transitions.push(t),
  );
  /** Acquires and fails one attempt at `now`. */
  const failAt = (now: number) => breaker.tryAcquire(now)?.fail(now);
  return { breaker, transitions, failAt };
}

describe("CircuitBreaker (spec 008, AC-8)", () => {
  it("starts closed and admits calls", () => {
    const { breaker } = setup();
    expect(breaker.state(0)).toBe("closed");
    expect(breaker.tryAcquire(0)?.probe).toBe(false);
  });

  it("opens after failureThreshold consecutive failures and skips calls for openMs", () => {
    const { breaker, failAt, transitions } = setup();
    failAt(0);
    failAt(1);
    expect(breaker.state(2)).toBe("closed");
    expect(breaker.consecutiveFailures).toBe(2);
    failAt(2);
    expect(breaker.state(2)).toBe("open");
    expect(breaker.halfOpenAt).toBe(1_002);
    expect(breaker.tryAcquire(1_001)).toBeUndefined();
    expect(transitions).toEqual([{ from: "closed", to: "open", consecutiveFailures: 3 }]);
  });

  it("a success resets the consecutive count", () => {
    const { breaker, failAt } = setup();
    failAt(0);
    failAt(0);
    breaker.tryAcquire(0)?.succeed();
    failAt(0);
    failAt(0);
    expect(breaker.state(0)).toBe("closed");
    expect(breaker.consecutiveFailures).toBe(2);
  });

  it("neutral outcomes (release) neither count nor reset", () => {
    const { breaker, failAt } = setup();
    failAt(0);
    breaker.tryAcquire(0)?.release();
    failAt(0);
    expect(breaker.consecutiveFailures).toBe(2);
  });

  it("becomes half-open after openMs and admits exactly one probe", () => {
    const { breaker, failAt, transitions } = setup();
    for (const t of [0, 0, 0]) failAt(t);
    expect(breaker.state(1_000)).toBe("half-open");
    const probe = breaker.tryAcquire(1_000);
    expect(probe?.probe).toBe(true);
    expect(breaker.tryAcquire(1_000)).toBeUndefined();
    expect(breaker.admits(1_000)).toBe(false);
    expect(transitions.at(-1)).toEqual({ from: "open", to: "half-open", consecutiveFailures: 3 });
  });

  it("a successful probe closes the breaker and resets the count", () => {
    const { breaker, failAt, transitions } = setup();
    for (const t of [0, 0, 0]) failAt(t);
    breaker.tryAcquire(1_000)?.succeed();
    expect(breaker.state(1_000)).toBe("closed");
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.halfOpenAt).toBeUndefined();
    expect(transitions.at(-1)).toEqual({ from: "half-open", to: "closed", consecutiveFailures: 0 });
  });

  it("a failed probe reopens it for another openMs", () => {
    const { breaker, failAt, transitions } = setup();
    for (const t of [0, 0, 0]) failAt(t);
    breaker.tryAcquire(1_500)?.fail(1_500);
    expect(breaker.state(2_499)).toBe("open");
    expect(breaker.halfOpenAt).toBe(2_500);
    expect(breaker.state(2_500)).toBe("half-open");
    expect(transitions.map((t) => t.to)).toEqual(["open", "half-open", "open", "half-open"]);
  });

  it("a released probe frees the slot and stays half-open", () => {
    const { breaker, failAt } = setup();
    for (const t of [0, 0, 0]) failAt(t);
    breaker.tryAcquire(1_000)?.release();
    expect(breaker.state(1_000)).toBe("half-open");
    expect(breaker.tryAcquire(1_000)?.probe).toBe(true);
  });

  it("each permit settles once; later calls are ignored", () => {
    const { breaker } = setup();
    const permit = breaker.tryAcquire(0);
    permit?.fail(0);
    permit?.fail(0);
    permit?.succeed();
    expect(breaker.consecutiveFailures).toBe(1);
  });

  it("late results of calls admitted while closed do not close an open breaker", () => {
    const { breaker, failAt } = setup();
    const late = breaker.tryAcquire(0);
    for (const t of [0, 0, 0]) failAt(t);
    late?.succeed();
    expect(breaker.state(10)).toBe("open");
  });

  it("recordFailure counts a mid-stream failure while closed (ADR-0008)", () => {
    const { breaker } = setup();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(5);
    expect(breaker.state(5)).toBe("open");
    expect(breaker.halfOpenAt).toBe(1_005);
  });

  it("uses the current settings (hot reload)", () => {
    let threshold = 3;
    const breaker = new CircuitBreaker(() => ({ failureThreshold: threshold, openMs: 10 }));
    threshold = 1;
    breaker.tryAcquire(0)?.fail(0);
    expect(breaker.state(0)).toBe("open");
  });
});
