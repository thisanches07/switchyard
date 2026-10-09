import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

const requiredFiles = [
  ".gitattributes",
  ".editorconfig",
  ".nvmrc",
  ".gitignore",
  ".env.example",
  "LICENSE",
  "config/switchyard.example.yaml",
  ".vscode/extensions.json",
];

describe("repository files", () => {
  it.each(requiredFiles)("required repository file exists: %s", (file) => {
    expect(existsSync(resolve(root, file))).toBe(true);
  });

  it("gitattributes enforces LF", () => {
    const content = readFileSync(resolve(root, ".gitattributes"), "utf8");
    expect(content).toMatch(/^\* text=auto eol=lf$/m);
  });

  it("nvmrc pins Node 24", () => {
    expect(readFileSync(resolve(root, ".nvmrc"), "utf8").trim()).toBe("24");
  });
});
