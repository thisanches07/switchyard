import { describe, expect, it } from "vitest";
import type { Candidate } from "../../../src/modules/routing/resolve.js";
import { orderCandidates } from "../../../src/modules/routing/select.js";

const candidate = (ref: string): Candidate => {
  const slash = ref.indexOf("/");
  return { ref, provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
};
const refs = (list: Candidate[]) => list.map((c) => c.ref);
const four = ["a/1", "b/2", "c/3", "d/4"].map(candidate);

describe("orderCandidates (spec 008, AC-2)", () => {
  it("priority keeps config order", () => {
    expect(refs(orderCandidates("priority", four, {}))).toEqual(["a/1", "b/2", "c/3", "d/4"]);
  });

  it("does not reorder the input array in place", () => {
    const input = [...four];
    orderCandidates("lowest-cost", input, { cost: (c) => (c.ref === "d/4" ? 0 : 1) });
    expect(refs(input)).toEqual(["a/1", "b/2", "c/3", "d/4"]);
  });

  describe("lowest-cost", () => {
    it("orders by ascending estimated cost", () => {
      const prices: Record<string, number> = { "a/1": 0.3, "b/2": 0.1, "c/3": 0.2, "d/4": 0.05 };
      const order = orderCandidates("lowest-cost", four, { cost: (c) => prices[c.ref] });
      expect(refs(order)).toEqual(["d/4", "b/2", "c/3", "a/1"]);
    });

    it("puts unknown prices after every priced candidate, in config order", () => {
      const prices: Record<string, number | undefined> = { "b/2": 0.4, "d/4": 0.2 };
      const order = orderCandidates("lowest-cost", four, { cost: (c) => prices[c.ref] });
      expect(refs(order)).toEqual(["d/4", "b/2", "a/1", "c/3"]);
    });

    it("keeps ties in config order", () => {
      const order = orderCandidates("lowest-cost", four, {
        cost: (c) => (c.ref === "a/1" ? 0.5 : 0.1),
      });
      expect(refs(order)).toEqual(["b/2", "c/3", "d/4", "a/1"]);
    });

    it("free (0) is a price, not an unknown one", () => {
      const order = orderCandidates("lowest-cost", four, {
        cost: (c) => (c.ref === "c/3" ? 0 : undefined),
      });
      expect(refs(order)).toEqual(["c/3", "a/1", "b/2", "d/4"]);
    });

    it("without an estimator every price is unknown: config order", () => {
      expect(refs(orderCandidates("lowest-cost", four, {}))).toEqual(refs(four));
    });

    it("treats a non-finite estimate as unknown", () => {
      const order = orderCandidates("lowest-cost", four, {
        cost: (c) => (c.ref === "a/1" ? Number.NaN : 1),
      });
      expect(refs(order)).toEqual(["b/2", "c/3", "d/4", "a/1"]);
    });
  });

  describe("lowest-latency", () => {
    it("puts cold candidates first in config order, then ascending EWMA", () => {
      const ewma: Record<string, number | undefined> = { "a/1": 300, "c/3": 100 };
      const order = orderCandidates("lowest-latency", four, { latency: (c) => ewma[c.ref] });
      expect(refs(order)).toEqual(["b/2", "d/4", "c/3", "a/1"]);
    });

    it("orders measured candidates by EWMA, ties in config order", () => {
      const ewma: Record<string, number> = { "a/1": 50, "b/2": 20, "c/3": 50, "d/4": 10 };
      const order = orderCandidates("lowest-latency", four, { latency: (c) => ewma[c.ref] });
      expect(refs(order)).toEqual(["d/4", "b/2", "a/1", "c/3"]);
    });

    it("without latency data every candidate is cold: config order", () => {
      expect(refs(orderCandidates("lowest-latency", four, {}))).toEqual(refs(four));
    });
  });
});
