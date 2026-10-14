import { afterEach, describe, expect, it } from "vitest";
import type { ExactCacheStore } from "../../../src/core/cache.js";
import { MemoryExactCache } from "../../../src/infra/memory/exact-cache.js";
import { cacheApp, cacheConfig, sseData } from "../../helpers/cache.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";

const ANA = "ana.silva@example.com";
const BRUNO = "bruno.souza@example.org";

/** Memory exact cache that also records what is read and written. */
function recordingCache() {
  const inner = new MemoryExactCache();
  const written: string[] = [];
  let reads = 0;
  const store: ExactCacheStore = {
    async getMany(keys) {
      reads += 1;
      return inner.getMany(keys);
    },
    async set(key, value, ttl) {
      written.push(`${key} ${value}`);
      return inner.set(key, value, ttl);
    },
  };
  return { store, written, reads: () => reads };
}

describe("cache and PII redaction (spec 009, AC-11)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(piiMode: "mask" | "block") {
    const store = new MemoryKeyStore();
    const cache = recordingCache();
    const setup = await cacheApp({
      store,
      exactCache: cache.store,
      config: cacheConfig({}, { pii: { defaultMode: "off" } }),
      authenticated: false,
    });
    apps.push(setup.app);
    const { key } = await store.issueKey({ team: "pii", piiMode });
    const ask = (email: string, stream = false) =>
      setup.chat(
        {
          model: "mock/echo",
          temperature: 0,
          stream,
          messages: [{ role: "user", content: `write to ${email}` }],
        },
        { authorization: `Bearer ${key}` },
      );
    return { ...setup, cache, ask };
  }

  it("keys on the masked request, stores placeholders and restores per request", async () => {
    const { ask, cache, spies } = await setup("mask");
    const first = await ask(ANA);
    expect(first.headers["x-switchyard-cache"]).toBe("miss");
    expect(first.json().choices[0].message.content).toContain(ANA);

    // Another address masks to the same placeholder: same masked request, so a hit…
    const second = await ask(BRUNO);
    expect(second.headers["x-switchyard-cache"]).toBe("hit");
    expect(spies.mock?.requests).toHaveLength(1);
    // …restored with this request's own value, never the first one's.
    const content = second.json().choices[0].message.content as string;
    expect(content).toContain(BRUNO);
    expect(content).not.toContain(ANA);

    // The cache holds placeholders only.
    expect(cache.written).toHaveLength(1);
    expect(cache.written[0]).toContain("<EMAIL_1>");
    expect(cache.written[0]).not.toContain(ANA);
  });

  it("never reaches the cache when PII block rejects the request", async () => {
    const { ask, cache, events } = await setup("block");
    const res = await ask(ANA);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("pii_detected");
    expect(cache.reads()).toBe(0);
    expect(cache.written).toHaveLength(0);
    expect(events[0]).toMatchObject({ outcome: "rejected", cacheStatus: "bypass" });
  });

  /** Text of a streamed answer: the joined `delta.content` of its SSE chunks. */
  const streamedText = (body: string) =>
    sseData(body)
      .flatMap((c) => (c.choices as { delta?: { content?: string } }[]) ?? [])
      .map((c) => c.delta?.content ?? "")
      .join("");

  it("restores a streamed hit like a live stream (spec 015), keeping placeholders stored", async () => {
    const { ask, cache, spies } = await setup("mask");
    await ask(ANA);
    const res = await ask(BRUNO, true);
    expect(res.headers["x-switchyard-cache"]).toBe("hit");
    expect(res.headers["x-switchyard-pii"]).toBe("masked");
    expect(spies.mock?.requests).toHaveLength(1);
    const text = streamedText(res.body);
    expect(text).toContain(BRUNO);
    expect(text).not.toContain("<EMAIL_1>");
    expect(res.body).not.toContain(ANA);
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(cache.written).toHaveLength(1);
    expect(cache.written[0]).toContain("<EMAIL_1>");
    expect(cache.written[0]).not.toContain(BRUNO);
  });

  it("stores a restored live stream with placeholders and serves it restored again", async () => {
    const { ask, cache, spies } = await setup("mask");
    const live = await ask(ANA, true);
    expect(live.headers["x-switchyard-cache"]).toBe("miss");
    expect(streamedText(live.body)).toContain(ANA);
    expect(cache.written).toHaveLength(1);
    expect(cache.written[0]).toContain("<EMAIL_1>");
    expect(cache.written[0]).not.toContain(ANA);

    const hit = await ask(BRUNO, true);
    expect(hit.headers["x-switchyard-cache"]).toBe("hit");
    expect(streamedText(hit.body)).toContain(BRUNO);
    // A non-streaming hit of the same entry is restored per request too.
    const json = await ask(ANA);
    expect(json.headers["x-switchyard-cache"]).toBe("hit");
    expect(json.json().choices[0].message.content).toContain(ANA);
    expect(spies.mock?.requests).toHaveLength(1);
  });
});
