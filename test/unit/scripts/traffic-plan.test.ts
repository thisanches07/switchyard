import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIX,
  parseTrafficArgs,
  pickKind,
  planRequests,
  REQUEST_KINDS,
} from "../../../scripts/lib/traffic-plan.ts";
import { seededRandom } from "../../helpers/routing.js";

describe("demo traffic plan (spec 011, AC-10)", () => {
  it("parses duration, rate and mix, with defaults", () => {
    expect(parseTrafficArgs([])).toEqual({ durationSeconds: 300, rps: 4, mix: DEFAULT_MIX });
    expect(
      parseTrafficArgs(["--duration", "30", "--rps=2", "--mix", "chat=1,error=3,burst=0"]),
    ).toEqual({
      durationSeconds: 30,
      rps: 2,
      mix: { chat: 1, stream: 0, embeddings: 0, repeat: 0, error: 3, burst: 0 },
    });
  });

  it("rejects bad arguments", () => {
    expect(() => parseTrafficArgs(["--duration", "0"])).toThrow(/duration/);
    expect(() => parseTrafficArgs(["--rps", "-1"])).toThrow(/rps/);
    expect(() => parseTrafficArgs(["--mix", "paid=1"])).toThrow(/unknown request kind "paid"/);
    expect(() => parseTrafficArgs(["--mix", "chat=0"])).toThrow(/mix/);
    expect(() => parseTrafficArgs(["--wat"])).toThrow(/unknown option/);
  });

  it("picks kinds in proportion to the mix", () => {
    const random = seededRandom(7);
    const counts = Object.fromEntries(REQUEST_KINDS.map((k) => [k, 0])) as Record<string, number>;
    const mix = { chat: 6, stream: 2, embeddings: 1, repeat: 1, error: 0, burst: 0 };
    for (let i = 0; i < 10_000; i += 1) {
      const kind = pickKind(mix, random);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts.error).toBe(0);
    expect(counts.burst).toBe(0);
    expect((counts.chat ?? 0) / 10_000).toBeCloseTo(0.6, 1);
    expect((counts.stream ?? 0) / 10_000).toBeCloseTo(0.2, 1);
  });

  it("only ever targets the mock provider", () => {
    const random = seededRandom(1);
    for (const kind of REQUEST_KINDS) {
      for (let i = 0; i < 20; i += 1) {
        for (const request of planRequests(kind, i, random)) {
          expect(String(request.body.model)).toMatch(/^mock\//);
        }
      }
    }
  });

  it("covers successes, streams, embeddings, repeats, forced errors and a burst", () => {
    const random = seededRandom(3);
    const [stream] = planRequests("stream", 0, random);
    expect(stream?.body).toMatchObject({ stream: true });
    expect(planRequests("embeddings", 0, random)[0]?.path).toBe("/v1/embeddings");

    const repeats = [0, 1, 2].map((i) => JSON.stringify(planRequests("repeat", i, random)));
    expect(new Set(repeats).size).toBe(1);

    const errors = [0, 1, 2, 3, 4].map((i) => planRequests("error", i, random)[0]?.body.model);
    expect(errors).toEqual(expect.arrayContaining(["mock/error-500", "mock/error-503"]));
    expect(errors.every((m) => /^mock\/error-/.test(String(m)))).toBe(true);

    const burst = planRequests("burst", 0, random);
    expect(burst.length).toBeGreaterThan(2);
    expect(burst.every((r) => r.key === "limited")).toBe(true);
  });
});
