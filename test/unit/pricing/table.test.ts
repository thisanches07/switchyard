import { describe, expect, it } from "vitest";
import { decimal } from "../../../src/modules/pricing/decimal.js";
import {
  type PriceEntry,
  PriceTable,
  unknownPriceCandidates,
} from "../../../src/modules/pricing/table.js";

const usd = (value: string) => decimal(value);
const entry = (input: string | "TODO", output: string | "TODO", cachedInput?: string | "TODO") =>
  ({
    input: input === "TODO" ? "TODO" : usd(input),
    output: output === "TODO" ? "TODO" : usd(output),
    ...(cachedInput === undefined
      ? {}
      : { cachedInput: cachedInput === "TODO" ? "TODO" : usd(cachedInput) }),
  }) satisfies PriceEntry;

describe("PriceTable: entry precedence (spec 007, AC-1)", () => {
  const table = new PriceTable([
    ["mock/*", entry("1", "2")],
    ["*", entry("9", "9")],
    ["mock/fast-*", entry("3", "4")],
    ["mock/fast-model", entry("5", "6")],
    ["open*/meta-llama/*", entry("7", "8")],
    ["openrouter/*", entry("10", "10")],
  ]);

  it("prefers an exact key", () => {
    expect(table.entryFor("mock/fast-model")).toEqual(entry("5", "6"));
  });

  it("then the pattern with the most non-* characters", () => {
    expect(table.entryFor("mock/fast-other")).toEqual(entry("3", "4"));
    expect(table.entryFor("mock/slow")).toEqual(entry("1", "2"));
    expect(table.entryFor("anything/else")).toEqual(entry("9", "9"));
  });

  it("lets * match slashes", () => {
    // "open*/meta-llama/*" (16 non-* chars) beats "openrouter/*" (11).
    expect(table.entryFor("openrouter/meta-llama/llama-3.3-70b")).toEqual(entry("7", "8"));
  });

  it("breaks ties by file order and escapes regex characters", () => {
    const tie = new PriceTable([
      ["a/*x", entry("1", "1")],
      ["a/x*", entry("2", "2")],
      ["b/v1.0*", entry("3", "3")],
    ]);
    expect(tie.entryFor("a/xx")).toEqual(entry("1", "1"));
    expect(tie.entryFor("b/v1x0")).toBeUndefined();
  });

  it("has no entry for an unlisted model", () => {
    expect(new PriceTable([["mock/*", entry("1", "2")]]).entryFor("groq/x")).toBeUndefined();
    expect(PriceTable.empty().entryFor("mock/x")).toBeUndefined();
  });
});

describe("PriceTable: cost (spec 007, AC-2)", () => {
  it("prices input and output per 1M tokens with 10 decimal places", () => {
    const table = new PriceTable([["mock/*", entry("1.0", "2.0")]]);
    expect(table.costUsd("mock/m", { inputTokens: 3, outputTokens: 6 })).toBe("0.0000150000");
    expect(table.costUsd("mock/m", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      "1.0000000000",
    );
  });

  it("prices cached input at cachedInput, a subset of inputTokens", () => {
    const table = new PriceTable([["p/m", entry("3", "15", "0.3")]]);
    // (1000 − 400) × 3 + 400 × 0.3 + 100 × 15 = 1800 + 120 + 1500 = 3420 → /1e6
    expect(
      table.costUsd("p/m", { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 }),
    ).toBe("0.0034200000");
  });

  it("prices cached input at the input rate when cachedInput is absent", () => {
    const table = new PriceTable([["p/m", entry("3", "15")]]);
    expect(
      table.costUsd("p/m", { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 400 }),
    ).toBe("0.0030000000");
  });

  it("never counts more cached tokens than input tokens", () => {
    const table = new PriceTable([["p/m", entry("1", "1", "0")]]);
    expect(table.costUsd("p/m", { inputTokens: 10, outputTokens: 0, cachedInputTokens: 50 })).toBe(
      "0.0000000000",
    );
  });

  it("rounds half-up at the 10th place", () => {
    const table = new PriceTable([["p/m", entry("0.00005", "0")]]);
    // 1 × 0.00005 / 1e6 = 0.00000000005 → 0.0000000001
    expect(table.costUsd("p/m", { inputTokens: 1, outputTokens: 0 })).toBe("0.0000000001");
    expect(table.costUsd("p/m", { inputTokens: 0, outputTokens: 0 })).toBe("0.0000000000");
  });

  it("is exact for prices floats cannot represent", () => {
    const table = new PriceTable([["p/m", entry("0.1", "0.2")]]);
    expect(table.costUsd("p/m", { inputTokens: 3, outputTokens: 3 })).toBe("0.0000009000");
  });

  it("is unknown (null) when no entry matches or a needed price is TODO", () => {
    const table = new PriceTable([
      ["todo/in", entry("TODO", "1")],
      ["todo/out", entry("1", "TODO")],
      ["todo/cached", entry("1", "1", "TODO")],
    ]);
    expect(table.costUsd("other/m", { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(table.costUsd("todo/in", { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(table.costUsd("todo/out", { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(
      table.costUsd("todo/cached", { inputTokens: 5, outputTokens: 1, cachedInputTokens: 2 }),
    ).toBeNull();
  });

  it("does not need a price whose token count is 0", () => {
    const table = new PriceTable([
      ["todo/out", entry("1", "TODO")],
      ["todo/cached", entry("1", "1", "TODO")],
    ]);
    expect(table.costUsd("todo/out", { inputTokens: 2, outputTokens: 0 })).toBe("0.0000020000");
    expect(table.costUsd("todo/cached", { inputTokens: 2, outputTokens: 0 })).toBe("0.0000020000");
  });

  it("estimates as a number for routing (CostEstimator, spec 008)", () => {
    const table = new PriceTable([["mock/*", entry("1", "2")]]);
    expect(table.estimateUsd("mock/m", { inputTokens: 500_000, outputTokens: 250_000 })).toBe(1);
    expect(table.estimateUsd("groq/m", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});

describe("unknownPriceCandidates (spec 007, AC-1 boot warning)", () => {
  it("lists every distinct alias candidate without a known input and output price", () => {
    const table = new PriceTable([
      ["mock/*", entry("1", "2")],
      ["groq/llama", entry("TODO", "TODO")],
      ["claude/sonnet", entry("3", "15", "TODO")],
    ]);
    const aliases = {
      fast: { candidates: ["groq/llama", "mock/fast", "gemini/flash"] },
      smart: { candidates: ["claude/sonnet", "groq/llama"] },
    };
    expect(unknownPriceCandidates(aliases, table)).toEqual(["groq/llama", "gemini/flash"]);
  });
});
