/** Loads and validates `config/pricing.yaml` (spec 007, AC-1). Prices are USD per 1M tokens. */
import { z } from "zod";
import { ConfigError } from "../../config/errors.js";
import { readYaml } from "../../config/load.js";
import { toConfigIssues } from "../../config/zod-issues.js";
import { decimal } from "./decimal.js";
import { type Price, type PriceEntry, PriceTable } from "./table.js";

const price = z.union([
  z.number().nonnegative().finite(),
  z.literal("TODO", { error: 'must be a non-negative number or "TODO"' }),
]);

const entrySchema = z.strictObject({
  input: price,
  output: price,
  cachedInput: price.optional(),
  /** When the price was last checked against the provider's pricing page. */
  verifiedAt: z.union([z.iso.date(), z.date()]).optional(),
  note: z.string().optional(),
});

const fileSchema = z.strictObject({
  models: z.record(z.string().min(1), entrySchema),
});

const toPrice = (value: number | "TODO"): Price => (value === "TODO" ? "TODO" : decimal(value));

/** Throws a ConfigError naming the file and each offending entry. */
export function loadPricing(path: string): PriceTable {
  const result = fileSchema.safeParse(readYaml(path));
  if (!result.success) throw new ConfigError(path, toConfigIssues(result.error));
  return new PriceTable(
    Object.entries(result.data.models).map(([key, entry]): [string, PriceEntry] => [
      key,
      {
        input: toPrice(entry.input),
        output: toPrice(entry.output),
        ...(entry.cachedInput === undefined ? {} : { cachedInput: toPrice(entry.cachedInput) }),
      },
    ]),
  );
}
