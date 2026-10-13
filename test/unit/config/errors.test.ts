import { describe, expect, it } from "vitest";
import { ConfigError, formatConfigError } from "../../../src/config/errors.js";

describe("formatConfigError", () => {
  it("formats issues with path and source", () => {
    const error = new ConfigError("config/switchyard.yaml", [
      { path: "aliases.fast.candidates[1]", message: 'unknown provider "grok"' },
      { path: "cache.semantic.similarityThreshold", message: "must be ≤ 1" },
    ]);

    expect(formatConfigError(error)).toBe(
      [
        "Invalid configuration in config/switchyard.yaml:",
        '  - aliases.fast.candidates[1]: unknown provider "grok"',
        "  - cache.semantic.similarityThreshold: must be ≤ 1",
      ].join("\n"),
    );
  });

  it("omits the path prefix for root-level issues", () => {
    const error = new ConfigError("environment", [{ path: "", message: "file not found" }]);
    expect(formatConfigError(error)).toBe(
      "Invalid configuration in environment:\n  - file not found",
    );
  });

  it("is an Error with a readable message", () => {
    const error = new ConfigError("environment", [{ path: "PORT", message: "invalid" }]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("PORT: invalid");
  });
});
