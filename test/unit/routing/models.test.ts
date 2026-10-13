import { describe, expect, it } from "vitest";
import { listModels } from "../../../src/modules/routing/models.js";
import { testConfig } from "../../helpers/config.js";

describe("listModels", () => {
  it("lists aliases first, then distinct candidates in first-seen order", () => {
    const result = listModels(testConfig(), 1_791_590_000);
    expect(result.object).toBe("list");
    expect(result.data.map((m) => [m.id, m.owned_by])).toEqual([
      ["local", "switchyard"],
      ["fast", "switchyard"],
      ["smart", "switchyard"],
      ["ollama/llama3.2", "ollama"],
      ["mock/fast-model", "mock"],
      ["openrouter/meta-llama/llama-3.3-70b", "openrouter"],
    ]);
    expect(result.data[0]).toEqual({
      id: "local",
      object: "model",
      created: 1_791_590_000,
      owned_by: "switchyard",
    });
  });
});
