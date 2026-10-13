import { describe, expect, it } from "vitest";
import { AuthCache } from "../../../src/modules/auth/cache.js";

const record = (id: string) => ({ id, teamId: "t" });

describe("AuthCache", () => {
  it("returns cached entries until the TTL expires", () => {
    let now = 1_000;
    const cache = new AuthCache<{ id: string }>({ ttlMs: 30_000, maxEntries: 10, now: () => now });
    cache.set("h1", record("k1"));
    expect(cache.get("h1")).toEqual(record("k1"));
    now += 29_999;
    expect(cache.get("h1")).toEqual(record("k1"));
    now += 1;
    expect(cache.get("h1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new AuthCache<{ id: string }>({ ttlMs: 30_000, maxEntries: 2 });
    cache.set("h1", record("k1"));
    cache.set("h2", record("k2"));
    cache.get("h1"); // h1 becomes most recent
    cache.set("h3", record("k3"));
    expect(cache.get("h2")).toBeUndefined();
    expect(cache.get("h1")).toEqual(record("k1"));
    expect(cache.get("h3")).toEqual(record("k3"));
  });

  it("invalidates every entry of a key id", () => {
    const cache = new AuthCache<{ id: string }>({ ttlMs: 30_000, maxEntries: 10 });
    cache.set("h1", record("k1"));
    cache.set("h2", record("k2"));
    cache.invalidateKey("k1");
    expect(cache.get("h1")).toBeUndefined();
    expect(cache.get("h2")).toEqual(record("k2"));
  });

  it("overwrites an existing entry and refreshes its TTL", () => {
    let now = 0;
    const cache = new AuthCache<{ id: string }>({ ttlMs: 100, maxEntries: 10, now: () => now });
    cache.set("h1", record("k1"));
    now = 90;
    cache.set("h1", record("k1"));
    now = 150;
    expect(cache.get("h1")).toEqual(record("k1"));
  });
});
