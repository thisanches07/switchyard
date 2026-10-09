import { z } from "zod";

const positiveInt = z.number().int().positive();
const envVarName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");

/** `provider/model`; the model part may itself contain slashes (e.g. OpenRouter IDs). */
const modelRef = z.string().regex(/^[a-z0-9][a-z0-9-]*\/.+$/, "must be in the form provider/model");

const openAiCompatibleProvider = z
  .strictObject({
    type: z.literal("openai-compatible"),
    baseUrl: z.url().optional(),
    baseUrlEnv: envVarName.optional(),
    apiKeyEnv: envVarName.optional(),
  })
  .refine((p) => (p.baseUrl === undefined) !== (p.baseUrlEnv === undefined), {
    message: "set exactly one of baseUrl or baseUrlEnv",
  });

const anthropicProvider = z.strictObject({
  type: z.literal("anthropic"),
  baseUrl: z.url().optional(),
  apiKeyEnv: envVarName,
});

const mockProvider = z.strictObject({
  type: z.literal("mock"),
  latencyMs: z.number().int().nonnegative().default(0),
  errorRate: z.number().min(0).max(1).default(0),
});

const providerSchema = z.discriminatedUnion("type", [
  openAiCompatibleProvider,
  anthropicProvider,
  mockProvider,
]);

const aliasSchema = z.strictObject({
  strategy: z.enum(["priority", "lowest-cost", "lowest-latency"]),
  candidates: z.array(modelRef).min(1),
});

const serverSchema = z.strictObject({
  bodyLimitBytes: positiveInt.default(1_048_576),
  timeouts: z
    .strictObject({
      connectMs: positiveInt.default(5_000),
      ttfbMs: positiveInt.default(30_000),
      totalMs: positiveInt.default(120_000),
    })
    .prefault({}),
});

const cacheSchema = z.strictObject({
  exact: z
    .strictObject({ enabled: z.boolean().default(false), ttlSeconds: positiveInt.default(3600) })
    .prefault({}),
  semantic: z
    .strictObject({
      enabled: z.boolean().default(false),
      embeddingModel: modelRef.default("ollama/nomic-embed-text"),
      similarityThreshold: z.number().gt(0).lte(1).default(0.95),
      ttlSeconds: positiveInt.default(86_400),
    })
    .prefault({}),
});

export const configSchema = z
  .strictObject({
    server: serverSchema.prefault({}),
    providers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), providerSchema),
    aliases: z.record(z.string().min(1), aliasSchema).default({}),
    retry: z
      .strictObject({
        maxAttempts: positiveInt.default(3),
        baseDelayMs: positiveInt.default(200),
        maxDelayMs: positiveInt.default(2_000),
      })
      .prefault({}),
    circuitBreaker: z
      .strictObject({
        failureThreshold: positiveInt.default(5),
        openMs: positiveInt.default(30_000),
      })
      .prefault({}),
    cache: cacheSchema.prefault({}),
    pricingFile: z.string().min(1).default("config/pricing.yaml"),
  })
  .superRefine((config, ctx) => {
    const known = Object.keys(config.providers);
    const checkRef = (ref: string, path: PropertyKey[]) => {
      const provider = ref.slice(0, ref.indexOf("/"));
      if (!known.includes(provider)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `unknown provider "${provider}" (known: ${known.join(", ")})`,
        });
      }
    };
    for (const [name, alias] of Object.entries(config.aliases)) {
      alias.candidates.forEach((ref, i) => {
        checkRef(ref, ["aliases", name, "candidates", i]);
      });
    }
    if (config.cache.semantic.enabled) {
      checkRef(config.cache.semantic.embeddingModel, ["cache", "semantic", "embeddingModel"]);
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
