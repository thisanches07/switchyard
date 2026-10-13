import type { DataPoint, Histogram } from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthRecord } from "../../../src/core/auth.js";
import type { ChatChunk } from "../../../src/core/chat.js";
import { upstreamError } from "../../../src/core/errors.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { manualTimers } from "../../helpers/routing.js";

/**
 * Request duration and gateway overhead through the app (spec 011, AC-1/AC-2). One manual clock
 * drives everything: the provider "takes" its latency by advancing it, the key lookup and the
 * usage recorder stand in for gateway work. No wall clock, so the expected values are exact
 * (tolerance: floating-point rounding only, 1e-9 s).
 */
const KEY_LOOKUP_MS = 3;
const RECORDER_MS = 2;
const TOLERANCE_DIGITS = 9;

type Timers = ReturnType<typeof manualTimers>;
type Step = { ms: number; fail?: boolean };

/** A provider whose calls take scripted time on the manual clock. */
function scriptedProvider(timers: Timers, steps: Step[], chunkMs = 0): ChatProvider {
  const next = () => {
    const step = steps.shift() ?? { ms: 0 };
    timers.advance(step.ms);
    if (step.fail) throw upstreamError("mock");
  };
  const chunk = (content: string, finish: string | null = null): ChatChunk => ({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });
  return {
    name: "mock",
    type: "mock",
    async chat() {
      next();
      return {
        body: { id: "x", object: "chat.completion", choices: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async chatStream() {
      next();
      return (async function* () {
        yield chunk("a");
        timers.advance(chunkMs);
        yield chunk("b");
        timers.advance(chunkMs);
        yield chunk("", "stop");
      })();
    },
    async embeddings() {
      next();
      return { body: { object: "list", data: [] }, usage: { inputTokens: 1 } };
    },
  };
}

/** Key lookups take KEY_LOOKUP_MS of gateway time. */
class SlowKeyStore extends MemoryKeyStore {
  constructor(private readonly timers: Timers) {
    super();
  }
  override async findKeyByHash(hash: string): Promise<AuthRecord | undefined> {
    this.timers.advance(KEY_LOOKUP_MS);
    return super.findKeyByHash(hash);
  }
}

describe("request duration and gateway overhead (spec 011, AC-1, AC-2)", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeAll(() => {
    meters = installTestMetrics();
  });
  afterAll(async () => {
    await meters.uninstall();
  });
  beforeEach(async () => {
    // Fresh provider per test: points accumulate per label set otherwise.
    await meters.uninstall();
    meters = installTestMetrics();
  });

  async function run(
    steps: Step[],
    payload: Record<string, unknown>,
    options: { url?: string; chunkMs?: number } = {},
  ) {
    const timers = manualTimers();
    const provider = scriptedProvider(timers, steps, options.chunkMs);
    const { app } = await testApp({
      config: testConfig({
        retry: { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 2000 },
      }),
      providers: new Map([["mock", provider]]),
      store: new SlowKeyStore(timers),
      usageRecorder: { record: () => timers.advance(RECORDER_MS) },
      routing: { timers, random: () => 0.5 },
    });
    const res = await app.inject({
      method: "POST",
      url: options.url ?? "/v1/chat/completions",
      payload: { model: "mock/m", messages: [{ role: "user", content: "hi" }], ...payload },
    });
    // The response's `close` event follows on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    await app.close();
    return { res, timers };
  }

  const histogram = async (name: string) => {
    const points = (await meters.points(name)) as DataPoint<Histogram>[];
    expect(points).toHaveLength(1);
    return points[0] as DataPoint<Histogram>;
  };
  const seconds = (ms: number) => ms / 1000;

  it("non-streaming: overhead = duration − provider time, with low-cardinality labels", async () => {
    const { res } = await run([{ ms: 100 }], {});
    expect(res.statusCode).toBe(200);

    const duration = await histogram("switchyard_request_duration_seconds");
    const overhead = await histogram("switchyard_gateway_overhead_seconds");
    expect(duration.value.sum).toBeCloseTo(
      seconds(KEY_LOOKUP_MS + 100 + RECORDER_MS),
      TOLERANCE_DIGITS,
    );
    expect(overhead.value.sum).toBeCloseTo(seconds(KEY_LOOKUP_MS + RECORDER_MS), TOLERANCE_DIGITS);
    expect(duration.value.count).toBe(1);
    // No team, key or model (AC-1).
    expect(duration.attributes).toEqual({ operation: "chat", stream: "false", status: "2xx" });
    expect(overhead.attributes).toEqual(duration.attributes);
  });

  it("streaming: overhead is measured to the first byte; later chunks do not count", async () => {
    const { res } = await run([{ ms: 40 }], { stream: true }, { chunkMs: 200 });
    expect(res.statusCode).toBe(200);

    const duration = await histogram("switchyard_request_duration_seconds");
    const overhead = await histogram("switchyard_gateway_overhead_seconds");
    expect(duration.value.sum).toBeCloseTo(
      seconds(KEY_LOOKUP_MS + 40 + 400 + RECORDER_MS),
      TOLERANCE_DIGITS,
    );
    expect(overhead.value.sum).toBeCloseTo(seconds(KEY_LOOKUP_MS), TOLERANCE_DIGITS);
    expect(duration.attributes).toEqual({ operation: "chat", stream: "true", status: "2xx" });
  });

  it("one retry: both attempts and the backoff wait are excluded", async () => {
    const { res, timers } = await run([{ ms: 50, fail: true }, { ms: 100 }], {});
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    const backoff = timers.sleeps[0] ?? 0;
    expect(backoff).toBeGreaterThan(0);

    const duration = await histogram("switchyard_request_duration_seconds");
    const overhead = await histogram("switchyard_gateway_overhead_seconds");
    expect(duration.value.sum).toBeCloseTo(
      seconds(KEY_LOOKUP_MS + 50 + backoff + 100 + RECORDER_MS),
      TOLERANCE_DIGITS,
    );
    expect(overhead.value.sum).toBeCloseTo(seconds(KEY_LOOKUP_MS + RECORDER_MS), TOLERANCE_DIGITS);
  });

  it("failed requests are recorded with their status class", async () => {
    const { res } = await run(
      [
        { ms: 10, fail: true },
        { ms: 10, fail: true },
      ],
      {},
    );
    expect(res.statusCode).toBe(502);
    const overhead = await histogram("switchyard_gateway_overhead_seconds");
    expect(overhead.attributes).toEqual({ operation: "chat", stream: "false", status: "5xx" });
    expect(overhead.value.min).toBeGreaterThanOrEqual(0);
  });

  it("labels embeddings by operation", async () => {
    await run([{ ms: 5 }], { input: "hi", messages: undefined }, { url: "/v1/embeddings" });
    const duration = await histogram("switchyard_request_duration_seconds");
    expect(duration.attributes).toEqual({
      operation: "embeddings",
      stream: "false",
      status: "2xx",
    });
  });

  it("does not record requests rejected before admission", async () => {
    const { res } = await run([], { model: "nope/unknown" });
    expect(res.statusCode).toBe(404);
    expect(await meters.points("switchyard_request_duration_seconds")).toEqual([]);
    expect(await meters.points("switchyard_gateway_overhead_seconds")).toEqual([]);
  });
});
