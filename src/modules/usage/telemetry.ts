import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api";

const DROP_REASONS = ["buffer_full", "shutdown", "invalid"] as const;
export type DropReason = (typeof DROP_REASONS)[number];
export type WorkerResult = "inserted" | "duplicate" | "dlq";

interface Instruments {
  provider: MeterProvider;
  dropped: Counter;
  published: Counter;
  workerEvents: Counter;
}
let instruments: Instruments | undefined;

/** Current buffer sizes, summed by the `switchyard_usage_buffer_events` gauge. */
const buffers = new Set<() => number>();

/** Instruments are bound to the current global MeterProvider (tests may swap it). */
function getInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider !== provider) {
    const meter = provider.getMeter("switchyard");
    meter
      .createObservableGauge("switchyard_usage_buffer_events", {
        description: "Usage events waiting in the gateway's in-memory buffer",
      })
      .addCallback((result) => {
        let total = 0;
        for (const size of buffers) total += size();
        result.observe(total);
      });
    instruments = {
      provider,
      dropped: meter.createCounter("switchyard_usage_events_dropped_total", {
        description: "Usage events the gateway dropped, by reason",
      }),
      published: meter.createCounter("switchyard_usage_events_published_total", {
        description: "Usage events acknowledged by Kafka",
      }),
      workerEvents: meter.createCounter("switchyard_usage_worker_events_total", {
        description: "Usage events handled by the worker, by result",
      }),
    };
    // A series per reason from the start, so dashboards and alerts see 0, not "no data" (spec 011).
    for (const reason of DROP_REASONS) instruments.dropped.add(0, { reason });
  }
  return instruments;
}

export const usageMetrics = {
  dropped(reason: DropReason, count = 1) {
    if (count > 0) getInstruments().dropped.add(count, { reason });
  },
  published(count: number) {
    if (count > 0) getInstruments().published.add(count);
  },
  worker(result: WorkerResult, count: number) {
    if (count > 0) getInstruments().workerEvents.add(count, { result });
  },
  /** Reports a buffer's size through the gauge until the returned function is called. */
  watchBuffer(size: () => number): () => void {
    getInstruments();
    buffers.add(size);
    return () => {
      buffers.delete(size);
    };
  },
};
