import { describe, expect, it } from "vitest";
import type { CachedResponse, NewSemanticEntry } from "../../../src/core/cache.js";
import { MemoryExactCache } from "../../../src/infra/memory/exact-cache.js";
import { cosineSimilarity, MemorySemanticCache } from "../../../src/infra/memory/semantic-cache.js";

describe("MemoryExactCache (spec 009)", () => {
  it("returns values in key order and expires them on the injected clock", async () => {
    let now = 1_000;
    const cache = new MemoryExactCache({ now: () => now });
    await cache.set("a", "A", 10);
    await cache.set("b", "B", 20);
    expect(await cache.getMany(["b", "x", "a"])).toEqual(["B", null, "A"]);
    now += 10_000;
    expect(await cache.getMany(["a", "b"])).toEqual([null, "B"]);
  });

  it("is bounded and drops the oldest entry", async () => {
    const cache = new MemoryExactCache({ maxEntries: 2 });
    await cache.set("a", "1", 60);
    await cache.set("b", "2", 60);
    await cache.set("c", "3", 60);
    expect(cache.size).toBe(2);
    expect(await cache.getMany(["a", "b", "c"])).toEqual([null, "2", "3"]);
  });

  it("rejects every call while failing", async () => {
    const cache = new MemoryExactCache();
    cache.failing = true;
    await expect(cache.getMany(["a"])).rejects.toThrow();
    await expect(cache.set("a", "1", 1)).rejects.toThrow();
  });
});

describe("MemorySemanticCache (spec 009)", () => {
  const response = { v: 1 } as unknown as CachedResponse;
  const entry = (overrides: Partial<NewSemanticEntry>): NewSemanticEntry => ({
    teamId: "t1",
    model: "mock/a",
    paramsHash: "p1",
    embedding: [1, 0, 0],
    response,
    createdAt: new Date(0),
    expiresAt: new Date(10_000),
    ...overrides,
  });
  const scope = { teamId: "t1", models: ["mock/a", "mock/b"], paramsHash: "p1" };

  it("returns the nearest unexpired entry in scope only", async () => {
    const cache = new MemorySemanticCache();
    await cache.insert(entry({ embedding: [1, 1, 0] }));
    await cache.insert(entry({ embedding: [1, 0.1, 0], model: "mock/b" }));
    await cache.insert(entry({ embedding: [1, 0, 0], teamId: "t2" }));
    await cache.insert(entry({ embedding: [1, 0, 0], paramsHash: "p2" }));
    await cache.insert(entry({ embedding: [1, 0, 0], model: "mock/c" }));
    await cache.insert(entry({ embedding: [1, 0, 0], expiresAt: new Date(5_000) }));

    const match = await cache.nearest(scope, [1, 0, 0], new Date(5_000));
    expect(match?.model).toBe("mock/b");
    expect(match?.similarity).toBeCloseTo(cosineSimilarity([1, 0.1, 0], [1, 0, 0]), 12);
    expect(await cache.nearest({ ...scope, teamId: "t3" }, [1, 0, 0], new Date(0))).toBeUndefined();
  });

  it("counts hits and deletes expired entries", async () => {
    const cache = new MemorySemanticCache();
    await cache.insert(entry({ expiresAt: new Date(100) }));
    await cache.insert(entry({ expiresAt: new Date(200) }));
    const match = await cache.nearest(scope, [1, 0, 0], new Date(0));
    await cache.recordHit(match?.id as string);
    expect(cache.entries.map((e) => e.hits)).toEqual([1, 0]);
    expect(await cache.deleteExpired(new Date(100))).toBe(1);
    expect(cache.entries).toHaveLength(1);
  });

  it("rejects every call while failing", async () => {
    const cache = new MemorySemanticCache();
    cache.failing = true;
    await expect(cache.nearest(scope, [1], new Date(0))).rejects.toThrow();
    await expect(cache.insert(entry({}))).rejects.toThrow();
  });

  it("cosineSimilarity handles zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });
});
