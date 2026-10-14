// Spec 012 AC-6: the committed benchmark tables are exactly what `pnpm bench:report` generates
// from bench/results/, so no number can be typed by hand. Runs in `pnpm verify`.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { publishedFiles } from "../../../bench/lib/publish.ts";

const root = resolve(import.meta.dirname, "../../..");

describe("published benchmark tables (AC-6)", () => {
  it.each(publishedFiles(root).map((file) => [file.path, file] as const))(
    "%s matches `pnpm bench:report` (run it and commit the result if this fails)",
    (_path, file) => {
      expect(file.current).toBe(file.expected);
    },
  );
});
