import { describe, expect, it } from "vitest";
import { resolveModel } from "../../../src/modules/routing/resolve.js";
import { testConfig } from "../../helpers/config.js";

const config = testConfig();

describe("resolveModel", () => {
  it("alias resolves to its first candidate", () => {
    expect(resolveModel("fast", config)).toEqual({
      provider: "mock",
      model: "fast-model",
      alias: "fast",
    });
  });

  it("provider/model resolves to that provider", () => {
    expect(resolveModel("ollama/qwen2.5:7b", config)).toEqual({
      provider: "ollama",
      model: "qwen2.5:7b",
    });
  });

  it("keeps slashes in the model part", () => {
    expect(resolveModel("openrouter/meta-llama/llama-3.3-70b", config)).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b",
    });
  });

  it("alias candidates with slashes in the model part resolve correctly", () => {
    expect(resolveModel("smart", config)).toMatchObject({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b",
    });
  });

  it.each(["gpt-4o", "grok/llama", "ollama/", "/llama", ""])(
    "unknown model %j → undefined",
    (m) => {
      expect(resolveModel(m, config)).toBeUndefined();
    },
  );
});
