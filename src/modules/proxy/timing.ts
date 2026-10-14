/**
 * Request duration and gateway overhead (spec 011, AC-1/AC-2, design §4.1). Every term is read
 * from one injected clock (`routing.timers.now()`), so tests drive it by hand.
 */
import type { UsageEvent } from "../../core/usage.js";

export interface TimingSample {
  startMs: number;
  /** The response closed (last byte sent, or the client left). */
  endMs: number;
  /** Streams: headers and the first chunk handed to the client. */
  firstByteMs?: number | undefined;
  /** Sum of every upstream attempt (to the first chunk for streams). */
  upstreamMs: number;
  /** Sum of retry backoff waits: neither upstream time nor overhead. */
  backoffMs: number;
  stream: boolean;
}

/**
 * The time Switchyard itself adds. Non-streaming: duration − upstream − backoff. Streaming: the
 * same on the first-byte path (after the first chunk the provider sets the pace); a stream that
 * failed before its first byte uses its whole duration. Never negative.
 */
export function gatewayOverheadMs(sample: TimingSample): number {
  const until =
    sample.stream && sample.firstByteMs !== undefined ? sample.firstByteMs : sample.endMs;
  return Math.max(0, until - sample.startMs - sample.upstreamMs - sample.backoffMs);
}

export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/** Low-cardinality labels of the duration and overhead histograms (AC-1). */
export interface TimingLabels {
  operation: string;
  stream: string;
  status: string;
  /** Spec 009 cache status: `hit`, `semantic_hit`, `miss` or `bypass`. */
  cache: string;
}

export interface TimingRecord {
  durationMs: number;
  overheadMs: number;
  labels: TimingLabels;
}

/** Timing of one `/v1` request; recorded once, when both the response and the outcome ended. */
export interface RequestTiming {
  /** One upstream attempt took `ms` (spec 008 attempt loop). */
  attempt(ms: number): void;
  /** A retry backoff wait of `ms`. */
  backoff(ms: number): void;
  /** Streams: the first byte goes to the client now (first call wins). */
  firstByte(): void;
  /** The response closed. */
  ended(): void;
  /** The request's usage event (spec 006 outcome); requests without one are never recorded. */
  outcome(event: UsageEvent): void;
}

export function createRequestTiming(
  now: () => number,
  record: (record: TimingRecord) => void,
): RequestTiming {
  const startMs = now();
  let upstreamMs = 0;
  let backoffMs = 0;
  let firstByteMs: number | undefined;
  let endMs: number | undefined;
  let event: UsageEvent | undefined;
  let recorded = false;

  const flush = () => {
    if (recorded || endMs === undefined || event === undefined) return;
    recorded = true;
    const sample = { startMs, endMs, firstByteMs, upstreamMs, backoffMs, stream: event.stream };
    record({
      durationMs: Math.max(0, endMs - startMs),
      overheadMs: gatewayOverheadMs(sample),
      labels: {
        operation: event.operation,
        stream: String(event.stream),
        status: statusClass(event.status),
        cache: event.cacheStatus,
      },
    });
  };

  return {
    attempt(ms) {
      upstreamMs += Math.max(0, ms);
    },
    backoff(ms) {
      backoffMs += Math.max(0, ms);
    },
    firstByte() {
      firstByteMs ??= now();
    },
    ended() {
      endMs ??= now();
      flush();
    },
    outcome(recordedEvent) {
      event ??= recordedEvent;
      flush();
    },
  };
}
