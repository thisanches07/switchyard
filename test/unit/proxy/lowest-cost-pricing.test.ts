import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPricing } from "../../../src/modules/pricing/load.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { spiedRegistry } from "../../helpers/providers.js";

const pricing = loadPricing(resolve(import.meta.dirname, "../../fixtures/pricing/routing.yaml"));

describe("lowest-cost with the spec 007 price table (spec 008, AC-2)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup() {
    const { registry, spies } = spiedRegistry();
    const { app } = await testApp({
      config: testConfig({
        aliases: {
          cheap: {
            strategy: "lowest-cost",
            candidates: ["openrouter/unpriced", "mock/pricey", "ollama/cheap"],
          },
          fallback: {
            strategy: "lowest-cost",
            candidates: ["openrouter/unpriced", "mock/error-503", "ollama/error-503"],
          },
        },
      }),
      providers: registry,
      costEstimator: pricing,
    });
    apps.push(app);
    const chat = (model: string) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model, messages: [{ role: "user", content: "hello" }] },
      });
    return { chat, spies };
  }

  it("serves the cheapest priced candidate and reports its cost", async () => {
    const { chat } = await setup();
    const res = await chat("cheap");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-provider"]).toBe("ollama");
    expect(res.headers["x-switchyard-cost-usd"]).toMatch(/^\d+\.\d+$/);
  });

  it("falls back by ascending price, with the unknown price last", async () => {
    const { chat, spies } = await setup();
    const res = await chat("fallback");
    expect(res.headers["x-switchyard-attempts"]).toBe("3");
    expect(res.headers["x-switchyard-provider"]).toBe("openrouter");
    expect(spies.ollama?.requests).toHaveLength(1);
    expect(spies.mock?.requests).toHaveLength(1);
  });
});
