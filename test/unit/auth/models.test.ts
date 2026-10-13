import { describe, expect, it } from "vitest";
import { isModelAllowed } from "../../../src/modules/auth/models.js";

describe("isModelAllowed", () => {
  it("allows everything when the list is null or empty", () => {
    expect(isModelAllowed(null, "fast", "mock/fast-model")).toBe(true);
    expect(isModelAllowed([], "fast", "mock/fast-model")).toBe(true);
  });

  it("matches the requested alias", () => {
    expect(isModelAllowed(["fast"], "fast", "mock/fast-model")).toBe(true);
    expect(isModelAllowed(["local"], "fast", "mock/fast-model")).toBe(false);
  });

  it("matches the resolved provider/model, even when called through an alias", () => {
    expect(isModelAllowed(["mock/fast-model"], "fast", "mock/fast-model")).toBe(true);
    expect(isModelAllowed(["mock/fast-model"], "mock/fast-model", "mock/fast-model")).toBe(true);
  });

  it("supports provider wildcards", () => {
    expect(isModelAllowed(["ollama/*"], "local", "ollama/llama3.2")).toBe(true);
    expect(isModelAllowed(["ollama/*"], "openrouter/x", "openrouter/x")).toBe(false);
  });
});
