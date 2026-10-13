import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExactCacheStore } from "../../../src/core/cache.js";
import { cacheApp } from "../../helpers/cache.js";
import { installTestMetrics } from "../../helpers/metrics.js";
import { manualTimers } from "../../helpers/routing.js";

const ask = { model: "fast", temperature: 0, messages: [{ role: "user", content: "hi" }] };

describe("exact cache failures (spec 009, AC-12)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  let metrics: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    metrics = installTestMetrics();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    await metrics.uninstall();
  });

  const errors = async (labels: Record<string, string>) =>
    (await metrics.points("switchyard_cache_errors_total"))
      .filter((p) => Object.entries(labels).every(([k, v]) => p.attributes[k] === v))
      .reduce((total, p) => total + (p.value as number), 0);

  it("serves the request as a miss while the store fails, warning once per minute", async () => {
    const timers = manualTimers();
    const setup = await cacheApp({ routing: { timers } });
    apps.push(setup.app);
    setup.exact.failing = true;

    const first = await setup.chat(ask);
    const second = await setup.chat(ask);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.headers["x-switchyard-cache"]).toBe("miss");
    expect(setup.spies.mock?.requests).toHaveLength(2);
    expect(await errors({ layer: "exact", stage: "lookup" })).toBe(2);
    expect(await errors({ layer: "exact", stage: "write" })).toBe(2);
    const warnings = () => setup.logs.filter((l) => l.msg === "cache layer skipped");
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(warnings())).not.toContain("sy:cache");

    timers.advance(60_000);
    await setup.chat(ask);
    expect(warnings()).toHaveLength(2);
    expect(setup.events.map((e) => e.cacheStatus)).toEqual(["miss", "miss", "miss"]);
  });

  it("treats an unparseable stored value as a lookup error and calls the provider", async () => {
    const garbage: ExactCacheStore = {
      getMany: async (keys) => keys.map(() => '{"v":2}'),
      set: async () => {},
    };
    const setup = await cacheApp({ exactCache: garbage });
    apps.push(setup.app);
    const res = await setup.chat(ask);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-cache"]).toBe("miss");
    expect(setup.spies.mock?.requests).toHaveLength(1);
    expect(await errors({ layer: "exact", stage: "lookup" })).toBe(1);
  });
});
