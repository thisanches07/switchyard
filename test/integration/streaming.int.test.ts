import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createLogger } from "../../src/infra/logger.js";
import { createMockProvider } from "../../src/modules/providers/mock.js";
import { testConfig } from "../helpers/config.js";
import { installTestMetrics } from "../helpers/metrics.js";
import { spyProvider } from "../helpers/providers.js";

describe("streaming over a real socket", () => {
  let app: FastifyInstance;
  let url: string;
  let meters: ReturnType<typeof installTestMetrics>;
  const spy = spyProvider(
    createMockProvider("mock", { latencyMs: 0, errorRate: 0, chunkDelayMs: 200 }),
  );

  beforeAll(async () => {
    meters = installTestMetrics();
    app = await buildApp({
      logger: createLogger({ level: "silent" }),
      checks: [],
      config: testConfig(),
      providers: new Map([["mock", spy.provider]]),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/chat/completions`;
  });

  afterAll(async () => {
    await app.close();
    await meters.uninstall();
  });

  const start = (signal?: AbortSignal) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/slow",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      ...(signal ? { signal } : {}),
    });

  it("delivers the first chunk long before the provider finishes (no buffering)", async () => {
    const started = performance.now();
    const res = await start();
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const arrivals: number[] = [];
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(performance.now() - started);
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("data: [DONE]");
    // 7 chunks 200 ms apart: the stream takes > 1 s, the first chunk must arrive well before that.
    expect(arrivals[0]).toBeLessThan((arrivals.at(-1) ?? 0) - 800);
  });

  it("aborts the upstream within 1 s when the client disconnects, recorded as 499", async () => {
    const controller = new AbortController();
    const res = await start(controller.signal);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();

    const upstreamSignal = spy.signals.at(-1);
    expect(upstreamSignal?.aborted).toBe(false);
    const abortedAt = performance.now();
    controller.abort();

    await expect.poll(() => upstreamSignal?.aborted, { timeout: 1_000, interval: 20 }).toBe(true);
    expect(performance.now() - abortedAt).toBeLessThan(1_000);

    await expect
      .poll(
        async () =>
          (await meters.points("switchyard_requests_total")).some(
            (p) => (p.attributes as { status?: string }).status === "499",
          ),
        { timeout: 2_000, interval: 50 },
      )
      .toBe(true);
  });
});
