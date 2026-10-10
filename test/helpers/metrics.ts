import { metrics } from "@opentelemetry/api";
import {
  type DataPoint,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

/** Installs a global MeterProvider whose metrics can be collected on demand. */
export function installTestMetrics() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  return {
    async points(name: string): Promise<DataPoint<unknown>[]> {
      const { resourceMetrics } = await reader.collect();
      return findPoints(resourceMetrics, name);
    },
    async uninstall() {
      await provider.shutdown();
      metrics.disable();
    },
  };
}

function findPoints(rm: ResourceMetrics, name: string): DataPoint<unknown>[] {
  return rm.scopeMetrics
    .flatMap((s) => s.metrics)
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints as DataPoint<unknown>[]);
}
