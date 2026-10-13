import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/config/errors.js";
import { loadPricing } from "../../../src/modules/pricing/load.js";

const root = resolve(import.meta.dirname, "../../..");

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-pricing-"));
  const path = join(dir, "pricing.yaml");
  writeFileSync(path, content);
  return path;
}

function issuesOf(path: string): string[] {
  try {
    loadPricing(path);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.source).toBe(path);
    return configError.issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error("expected a ConfigError");
}

describe("loadPricing (spec 007, AC-1)", () => {
  it("loads the repository price table: mock/* synthetic, real models unknown", () => {
    const table = loadPricing(resolve(root, "config/pricing.yaml"));
    expect(table.costUsd("mock/smoke", { inputTokens: 3, outputTokens: 6 })).toBe("0.0000150000");
    expect(table.costUsd("ollama/llama3.2", { inputTokens: 10, outputTokens: 10 })).toBe(
      "0.0000000000",
    );
    expect(
      table.costUsd("groq/llama-3.1-8b-instant", { inputTokens: 1, outputTokens: 1 }),
    ).toBeNull();
  });

  it("accepts TODO, cachedInput, verifiedAt and note", () => {
    const table = loadPricing(
      writeTemp(
        'models:\n  a/b: { input: 0.15, output: TODO, cachedInput: 0.075, verifiedAt: 2026-10-01, note: "x" }\n',
      ),
    );
    expect(table.costUsd("a/b", { inputTokens: 1_000_000, outputTokens: 0 })).toBe("0.1500000000");
  });

  it("rejects unknown fields, negative prices and strings other than TODO, naming the entry", () => {
    const issues = issuesOf(resolve(root, "test/fixtures/pricing/invalid.yaml"));
    expect(issues.some((i) => i.startsWith("models.mock/*.output:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("models.groq/x.output:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("models.gemini/y") && i.includes("discount"))).toBe(
      true,
    );
  });

  it("rejects a file without a models section", () => {
    expect(issuesOf(writeTemp("prices: {}\n")).length).toBeGreaterThan(0);
  });

  it("names a missing file", () => {
    expect(issuesOf(join(tmpdir(), "does-not-exist-pricing.yaml"))).toEqual([
      expect.stringContaining("file not found"),
    ]);
  });
});
