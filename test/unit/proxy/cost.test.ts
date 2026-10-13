import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "../../../src/core/usage.js";
import { decimal } from "../../../src/modules/pricing/decimal.js";
import { PriceTable } from "../../../src/modules/pricing/table.js";
import { testApp } from "../../helpers/app.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { spiedRegistry } from "../../helpers/providers.js";

/** Test-only prices: mock/* at $1 / $2 per 1M tokens (as in config/pricing.yaml), nothing else. */
const table = new PriceTable([["mock/*", { input: decimal("1"), output: decimal("2") }]]);
const messages = [{ role: "user", content: "12345678" }]; // 2 input tokens, 6 output (mock)

describe("cost per request (spec 007, AC-2/AC-3)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  let metrics: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    metrics = installTestMetrics();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await metrics.uninstall();
  });

  async function setup() {
    const events: UsageEvent[] = [];
    const { app } = await testApp({
      providers: spiedRegistry().registry,
      usageRecorder: { record: (event) => events.push(event) },
      costEstimator: table,
    });
    apps.push(app);
    return { app, events };
  }

  it("returns x-switchyard-cost-usd on a chat completion, equal to the event's costUsd", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", messages },
    });
    expect(res.statusCode).toBe(200);
    // (2 × 1 + 6 × 2) / 1e6
    expect(res.headers["x-switchyard-cost-usd"]).toBe("0.0000140000");
    expect(events[0]?.costUsd).toBe("0.0000140000");
  });

  it("returns it on embeddings and on /v1/messages", async () => {
    const { app, events } = await setup();
    const embeddings = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      payload: { model: "mock/embed", input: "12345678" },
    });
    expect(embeddings.headers["x-switchyard-cost-usd"]).toBe("0.0000020000");
    const message = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "fast", max_tokens: 50, messages },
    });
    expect(message.statusCode).toBe(200);
    expect(message.headers["x-switchyard-cost-usd"]).toBe(events[1]?.costUsd);
    expect(events[1]?.costUsd).toMatch(/^\d+\.\d{10}$/);
  });

  it("returns a known cost on an upstream error (nothing generated)", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mock/error-500", messages },
    });
    expect(res.statusCode).toBe(502);
    expect(res.headers["x-switchyard-cost-usd"]).toBe("0.0000000000");
    expect(events[0]?.costUsd).toBe("0.0000000000");
  });

  it("omits the header on streams, while the event carries the cost of the estimate", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", stream: true, messages },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cost-usd"]).toBeUndefined();
    expect(events[0]?.stream).toBe(true);
    expect(events[0]?.costUsd).toMatch(/^\d+\.\d{10}$/);
  });

  it("omits the header and records null when the price is unknown", async () => {
    const { app, events } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "local", messages },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cost-usd"]).toBeUndefined();
    expect(events[0]).toMatchObject({ provider: "ollama", costUsd: null });
  });

  it("counts known costs and unknown-cost requests per provider and model", async () => {
    const { app } = await setup();
    for (const model of ["fast", "fast", "local"]) {
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model, messages },
      });
    }
    const cost = await metrics.points("switchyard_cost_usd_total");
    expect(cost).toEqual([
      expect.objectContaining({
        attributes: { provider: "mock", model: "fast-model" },
        value: expect.closeTo(0.000028, 12),
      }),
    ]);
    const unknown = await metrics.points("switchyard_cost_unknown_requests_total");
    expect(unknown).toEqual([
      expect.objectContaining({ attributes: { provider: "ollama", model: "llama3.2" }, value: 1 }),
    ]);
  });

  it("treats every cost as unknown without a price table", async () => {
    const events: UsageEvent[] = [];
    const { app } = await testApp({
      providers: spiedRegistry().registry,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fast", messages },
    });
    expect(res.headers["x-switchyard-cost-usd"]).toBeUndefined();
    expect(events[0]?.costUsd).toBeNull();
  });
});
