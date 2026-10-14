// Entry point of the benchmark mock upstream (spec 012). Knobs: MOCK_LATENCY_MS,
// MOCK_CHUNK_DELAY_MS, MOCK_ERROR_RATE, PORT, or --latency-ms, --chunk-delay-ms, --error-rate,
// --port. Run from source with `node --import tsx bench/mock-upstream/main.ts`.
import { createMockUpstream, parseMockConfig } from "./server.js";

const config = parseMockConfig(process.env, process.argv.slice(2));
const server = createMockUpstream(config);

server.listen(config.port, "0.0.0.0", () => {
  console.log(
    `mock upstream on :${config.port} (latency ${config.latencyMs} ms, chunk delay ${config.chunkDelayMs} ms, error rate ${config.errorRate})`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
