import { describe, expect, it } from "vitest";
import { planRoute } from "../../../src/modules/routing/resolve.js";
import { testConfig } from "../../helpers/config.js";

const config = testConfig({
  aliases: {
    fast: { strategy: "priority", candidates: ["mock/fast-model", "ollama/llama3.2"] },
    cheap: { strategy: "lowest-cost", candidates: ["openrouter/meta-llama/llama-3.3-70b"] },
  },
});

describe("planRoute (spec 008, AC-1)", () => {
  it("an alias plans every candidate in config order with its strategy", () => {
    expect(planRoute("fast", config)).toEqual({
      requested: "fast",
      alias: "fast",
      strategy: "priority",
      candidates: [
        { ref: "mock/fast-model", provider: "mock", model: "fast-model" },
        { ref: "ollama/llama3.2", provider: "ollama", model: "llama3.2" },
      ],
    });
  });

  it("keeps slashes in alias candidate models", () => {
    expect(planRoute("cheap", config)?.candidates).toEqual([
      {
        ref: "openrouter/meta-llama/llama-3.3-70b",
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b",
      },
    ]);
    expect(planRoute("cheap", config)?.strategy).toBe("lowest-cost");
  });

  it("a plain provider/model has exactly one candidate and priority strategy", () => {
    expect(planRoute("ollama/qwen2.5:7b", config)).toEqual({
      requested: "ollama/qwen2.5:7b",
      strategy: "priority",
      candidates: [{ ref: "ollama/qwen2.5:7b", provider: "ollama", model: "qwen2.5:7b" }],
    });
  });

  it.each(["gpt-9", "unknown/model", "mock/", "/x"])("%s has no plan", (model) => {
    expect(planRoute(model, config)).toBeUndefined();
  });
});
