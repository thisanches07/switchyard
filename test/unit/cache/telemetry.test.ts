import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countCacheError,
  countLookup,
  createWarnLimiter,
  recordSavings,
  tagCacheSpan,
} from "../../../src/modules/cache/telemetry.js";
import { installTestMetrics } from "../../helpers/metrics.js";

describe("cache telemetry (spec 009, AC-9, AC-12, AC-13)", () => {
  let meters: ReturnType<typeof installTestMetrics>;
  beforeEach(() => {
    meters = installTestMetrics();
  });
  afterEach(async () => {
    await meters.uninstall();
  });

  const values = async (name: string) =>
    (await meters.points(name)).map((p) => ({ attributes: p.attributes, value: p.value }));

  it("counts lookups and errors by layer, result and stage", async () => {
    countLookup("exact", "hit");
    countLookup("exact", "hit");
    countLookup("semantic", "error");
    countCacheError("semantic", "lookup");
    countCacheError("exact", "write");
    expect(await values("switchyard_cache_lookups_total")).toEqual(
      expect.arrayContaining([
        { attributes: { layer: "exact", result: "hit" }, value: 2 },
        { attributes: { layer: "semantic", result: "error" }, value: 1 },
      ]),
    );
    expect(await values("switchyard_cache_errors_total")).toEqual(
      expect.arrayContaining([
        { attributes: { layer: "semantic", stage: "lookup" }, value: 1 },
        { attributes: { layer: "exact", stage: "write" }, value: 1 },
      ]),
    );
  });

  it("adds known savings and counts unknown prices apart", async () => {
    const labels = { model: "mock/fast-model", team: "t1" };
    recordSavings("exact", labels, 0.25);
    recordSavings("exact", labels, 0.5);
    recordSavings("semantic", labels, undefined);
    expect(await values("switchyard_cache_savings_usd_total")).toEqual([
      { attributes: { layer: "exact", ...labels }, value: 0.75 },
    ]);
    expect(await values("switchyard_cache_savings_unknown_total")).toEqual([
      { attributes: { layer: "semantic", ...labels }, value: 1 },
    ]);
  });
});

describe("createWarnLimiter (spec 009, AC-12)", () => {
  it("warns at most once per minute per layer on the injected clock", () => {
    let now = 0;
    const warned: unknown[] = [];
    const logger = { warn: (fields: unknown) => warned.push(fields) };
    const warn = createWarnLimiter(() => now);
    warn(logger, "exact", "lookup", new Error("down"));
    warn(logger, "exact", "write", new Error("down"));
    warn(logger, "semantic", "lookup", "timeout");
    now = 59_999;
    warn(logger, "exact", "lookup", new Error("down"));
    now = 60_000;
    warn(logger, "exact", "lookup", new Error("still down"));
    expect(warned).toEqual([
      { layer: "exact", stage: "lookup", err: "down" },
      { layer: "semantic", stage: "lookup", err: "timeout" },
      { layer: "exact", stage: "lookup", err: "still down" },
    ]);
  });
});

describe("tagCacheSpan (spec 009, AC-13)", () => {
  it("sets result, layer and rounded similarity on the request span", () => {
    const attributes: Record<string, unknown> = {};
    const span = { setAttributes: (a: Record<string, unknown>) => Object.assign(attributes, a) };
    const request = { opentelemetry: () => ({ span }) } as unknown as FastifyRequest;
    tagCacheSpan(request, { result: "semantic_hit", layer: "semantic", similarity: 0.987654 });
    expect(attributes).toEqual({
      "switchyard.cache.result": "semantic_hit",
      "switchyard.cache.layer": "semantic",
      "switchyard.cache.similarity": 0.9877,
    });
    tagCacheSpan({} as FastifyRequest, { result: "miss" });
  });
});
