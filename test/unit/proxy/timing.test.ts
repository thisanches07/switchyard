import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../../../src/core/usage.js";
import {
  createRequestTiming,
  gatewayOverheadMs,
  statusClass,
  type TimingRecord,
} from "../../../src/modules/proxy/timing.js";

describe("gatewayOverheadMs (spec 011, AC-2)", () => {
  it("non-streaming: duration minus upstream time and backoff waits", () => {
    expect(
      gatewayOverheadMs({ startMs: 0, endMs: 180, upstreamMs: 150, backoffMs: 20, stream: false }),
    ).toBe(10);
  });

  it("streaming: measured on the first-byte path", () => {
    expect(
      gatewayOverheadMs({
        startMs: 0,
        endMs: 5_000,
        firstByteMs: 60,
        upstreamMs: 50,
        backoffMs: 0,
        stream: true,
      }),
    ).toBe(10);
  });

  it("a stream that failed before its first byte uses the whole duration", () => {
    expect(
      gatewayOverheadMs({ startMs: 0, endMs: 70, upstreamMs: 60, backoffMs: 0, stream: true }),
    ).toBe(10);
  });

  it("a cache hit (no upstream time) is all overhead", () => {
    expect(
      gatewayOverheadMs({ startMs: 10, endMs: 14, upstreamMs: 0, backoffMs: 0, stream: false }),
    ).toBe(4);
  });

  it("is never negative", () => {
    expect(
      gatewayOverheadMs({ startMs: 0, endMs: 10, upstreamMs: 12, backoffMs: 0, stream: false }),
    ).toBe(0);
  });
});

describe("statusClass", () => {
  it("maps statuses to classes", () => {
    expect([200, 299, 404, 429, 499, 502, 504].map(statusClass)).toEqual([
      "2xx",
      "2xx",
      "4xx",
      "4xx",
      "4xx",
      "5xx",
      "5xx",
    ]);
  });
});

describe("RequestTiming", () => {
  const event = (overrides: Partial<UsageEvent> = {}) =>
    ({
      operation: "chat",
      stream: false,
      status: 200,
      cacheStatus: "miss",
      ...overrides,
    }) as UsageEvent;

  function setup(start = 1_000) {
    let now = start;
    const records: TimingRecord[] = [];
    const timing = createRequestTiming(
      () => now,
      (record) => records.push(record),
    );
    return { timing, records, advance: (ms: number) => (now += ms) };
  }

  it("records once, when the response has ended and the outcome is known (either order)", () => {
    const a = setup();
    a.advance(5);
    a.timing.attempt(20);
    a.advance(20);
    a.timing.outcome(event());
    expect(a.records).toEqual([]);
    a.advance(1);
    a.timing.ended();
    a.timing.ended();
    a.timing.outcome(event());
    expect(a.records).toEqual([
      {
        durationMs: 26,
        overheadMs: 6,
        labels: { operation: "chat", stream: "false", status: "2xx", cache: "miss" },
      },
    ]);

    const b = setup();
    b.advance(3);
    b.timing.ended();
    b.timing.outcome(event({ operation: "embeddings", status: 502 }));
    expect(b.records).toEqual([
      {
        durationMs: 3,
        overheadMs: 3,
        labels: { operation: "embeddings", stream: "false", status: "5xx", cache: "miss" },
      },
    ]);
  });

  it("streams: overhead stops at the first byte; backoff waits are excluded", () => {
    const { timing, records, advance } = setup();
    advance(2);
    timing.attempt(30);
    timing.backoff(100);
    timing.attempt(40);
    advance(170);
    timing.firstByte();
    advance(1_000);
    timing.firstByte();
    timing.outcome(event({ stream: true }));
    timing.ended();
    expect(records).toEqual([
      {
        durationMs: 1_172,
        overheadMs: 2,
        labels: { operation: "chat", stream: "true", status: "2xx", cache: "miss" },
      },
    ]);
  });

  it("never records without an outcome (request rejected before admission)", () => {
    const { timing, records } = setup();
    timing.ended();
    expect(records).toEqual([]);
  });
});
