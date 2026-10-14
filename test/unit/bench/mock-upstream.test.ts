import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockUpstream,
  failureStatus,
  parseMockConfig,
} from "../../../bench/mock-upstream/server.js";
import { GatewayError, upstreamError } from "../../../src/core/errors.js";
import { createUndiciClient } from "../../../src/infra/http/undici-client.js";
import { createOpenAiCompatibleProvider } from "../../../src/modules/providers/openai-compatible.js";

type Close = () => Promise<void>;
const closers: Close[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function start(
  config: { latencyMs?: number; chunkDelayMs?: number; errorRate?: number },
  random?: () => number,
): Promise<string> {
  const server = createMockUpstream(
    { latencyMs: 0, chunkDelayMs: 0, errorRate: 0, ...config },
    random ? { random } : {},
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

/** Deterministic PRNG (mulberry32) so the error-rate test is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chatBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "bench", messages: [{ role: "user", content: "hi" }], ...extra });

function post(base: string, body: string, path = "/chat/completions") {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("mock upstream config (AC-1)", () => {
  it("reads the knobs from the environment", () => {
    expect(
      parseMockConfig({
        MOCK_LATENCY_MS: "20",
        MOCK_CHUNK_DELAY_MS: "5",
        MOCK_ERROR_RATE: "0.3",
        PORT: "9200",
      }),
    ).toEqual({ latencyMs: 20, chunkDelayMs: 5, errorRate: 0.3, port: 9200 });
  });

  it("lets flags override the environment and keeps defaults otherwise", () => {
    expect(
      parseMockConfig({ MOCK_LATENCY_MS: "20" }, ["--latency-ms", "7", "--error-rate", "0.5"]),
    ).toEqual({ latencyMs: 7, chunkDelayMs: 0, errorRate: 0.5, port: 9100 });
  });

  it("rejects invalid values", () => {
    expect(() => parseMockConfig({ MOCK_ERROR_RATE: "1.5" })).toThrow(/errorRate/);
    expect(() => parseMockConfig({}, ["--latency-ms", "-1"])).toThrow(/latencyMs/);
    expect(() => parseMockConfig({}, ["--port"])).toThrow(/needs a value/);
  });
});

describe("mock upstream server (AC-1)", () => {
  it("answers a chat completion in the OpenAI shape", async () => {
    const base = await start({});
    const res = await post(base, chatBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-switchyard-request-id")).toBeNull();
    const body = (await res.json()) as { object: string; choices: { message: unknown }[] };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message).toEqual({
      role: "assistant",
      content: "This is a mock response.",
    });
  });

  it("honours the configured latency", async () => {
    const base = await start({ latencyMs: 120 });
    const started = performance.now();
    const res = await post(base, chatBody());
    await res.text();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(115);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("injects errors at the configured rate within a statistical tolerance", async () => {
    const base = await start({ errorRate: 0.3 }, seeded(42));
    const n = 400;
    let failures = 0;
    for (let i = 0; i < n; i += 1) {
      const res = await post(base, chatBody());
      await res.text();
      if (res.status === 503) failures += 1;
      else expect(res.status).toBe(200);
    }
    // 3 standard deviations of a binomial(400, 0.3) proportion is about 0.069.
    expect(Math.abs(failures / n - 0.3)).toBeLessThan(0.069);
  });

  it("returns random failures as a 503 OpenAI error the gateway's adapter retries", async () => {
    const base = await start({ errorRate: 1 });
    const res = await post(base, chatBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { message: "Mock upstream failure (503)", type: "server_error", code: "mock_failure" },
    });

    const http = createUndiciClient({ connectMs: 1_000, ttfbMs: 2_000, totalMs: 5_000 });
    closers.push(() => http.close());
    const provider = createOpenAiCompatibleProvider({ name: "flaky", baseUrl: base }, http);
    const error = await provider
      .chat(
        { model: "bench", messages: [{ role: "user", content: "hi" }] },
        { signal: new AbortController().signal },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).status).toBe(502);
  });

  it("answers error-<status> models with exactly that status", async () => {
    const base = await start({});
    const res = await post(base, chatBody({ model: "error-429" }));
    expect(res.status).toBe(429);
    const server = await post(base, chatBody({ model: "error-500" }));
    expect(server.status).toBe(500);
    expect(failureStatus("bench", upstreamError("x"))).toBe(503);
  });

  it("streams SSE chunks spaced by the configured delay, ending with [DONE]", async () => {
    const base = await start({ chunkDelayMs: 60 });
    const res = await post(base, chatBody({ stream: true }));
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const arrivals: number[] = [];
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value);
      const events = piece.split("\n\n").filter((e) => e.startsWith("data: ")).length;
      for (let i = 0; i < events; i += 1) arrivals.push(performance.now());
      text += piece;
    }
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // 7 chunks (role, 5 content pieces, finish) then [DONE]; chunk i waits chunkDelayMs.
    const chunkArrivals = arrivals.slice(0, 7);
    expect(chunkArrivals).toHaveLength(7);
    // Arrival is measured when the client reads, so one late read shortens the next gap:
    // check the mean gap tightly and each gap loosely.
    const gaps = chunkArrivals.slice(1).map((t, i) => t - (chunkArrivals[i] ?? 0));
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    expect(mean).toBeGreaterThanOrEqual(57);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(30);
  });

  it("produces a stream the gateway's openai-compatible adapter parses", async () => {
    const base = await start({ chunkDelayMs: 1 });
    const http = createUndiciClient({ connectMs: 1_000, ttfbMs: 2_000, totalMs: 5_000 });
    closers.push(() => http.close());
    const provider = createOpenAiCompatibleProvider({ name: "upstream", baseUrl: base }, http);
    const stream = await provider.chatStream(
      {
        model: "bench",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      },
      { signal: new AbortController().signal },
    );
    let content = "";
    let usage: unknown;
    for await (const raw of stream) {
      const chunk = raw as { choices: { delta?: { content?: string } }[]; usage?: unknown };
      const delta = chunk.choices[0]?.delta;
      content += delta?.content ?? "";
      if (chunk.usage) usage = chunk.usage;
    }
    expect(content).toBe("This is a mock response.");
    expect(usage).toMatchObject({ completion_tokens: 6 });
  });

  it("cuts the connection mid-stream for error-midstream", async () => {
    const base = await start({});
    // Headers may or may not have reached the client before the socket is destroyed.
    const read = post(base, chatBody({ model: "error-midstream", stream: true })).then((res) =>
      res.text(),
    );
    await expect(read).rejects.toThrow();
  });

  it("serves embeddings, health and rejects unknown routes or bodies", async () => {
    const base = await start({});
    const emb = await post(base, JSON.stringify({ model: "e", input: "hi" }), "/embeddings");
    const body = (await emb.json()) as { data: { embedding: number[] }[] };
    expect(body.data[0]?.embedding).toHaveLength(768);

    const health = await fetch(base.replace(/\/v1$/, "/healthz"));
    expect(await health.json()).toEqual({ status: "ok" });

    expect((await post(base, "not json")).status).toBe(400);
    expect((await post(base, chatBody(), "/unknown")).status).toBe(404);
  });
});
