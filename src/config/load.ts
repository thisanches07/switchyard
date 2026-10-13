import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { ConfigError, type ConfigIssue } from "./errors.js";
import {
  type AppConfig,
  configSchema,
  type ProviderConfig,
  type UsageConfig,
  usageSchema,
} from "./schema.js";
import { toConfigIssues } from "./zod-issues.js";

type OpenAiCompatible = Extract<ProviderConfig, { type: "openai-compatible" }>;

/** Provider config after environment resolution: `openai-compatible` always has a concrete `baseUrl`. */
export type ResolvedProvider =
  | (Omit<OpenAiCompatible, "baseUrl" | "baseUrlEnv"> & { baseUrl: string })
  | Exclude<ProviderConfig, { type: "openai-compatible" }>;

export type LoadedConfig = Omit<AppConfig, "providers"> & {
  providers: Record<string, ResolvedProvider>;
};

export function loadConfig(path: string, env: Record<string, string | undefined>): LoadedConfig {
  const result = configSchema.safeParse(readYaml(path));
  if (!result.success) {
    throw new ConfigError(path, toConfigIssues(result.error));
  }

  const issues: ConfigIssue[] = [];
  const providers: Record<string, ResolvedProvider> = {};
  for (const [name, provider] of Object.entries(result.data.providers)) {
    const resolved = resolveProvider(name, provider, env, issues);
    if (resolved) providers[name] = resolved;
  }
  if (issues.length > 0) {
    throw new ConfigError(path, issues);
  }

  return { ...result.data, providers };
}

/**
 * Only the `usage` section of the config file (spec 006). The usage worker uses it so it never
 * needs provider settings or their environment variables.
 */
export function loadUsageConfig(path: string): UsageConfig {
  const root = readYaml(path);
  const section =
    typeof root === "object" && root !== null ? Reflect.get(root, "usage") : undefined;
  const result = usageSchema.safeParse(section ?? {});
  if (!result.success) {
    throw new ConfigError(
      path,
      toConfigIssues(result.error).map((issue) => ({
        ...issue,
        path: issue.path ? `usage.${issue.path}` : "usage",
      })),
    );
  }
  return result.data;
}

/** Reads and parses a YAML file; syntax errors become a ConfigError with line and column. */
function readYaml(path: string): unknown {
  const doc = parseDocument(readSource(path));
  if (doc.errors.length > 0) {
    throw new ConfigError(
      path,
      doc.errors.map((e) => {
        const pos = e.linePos?.[0];
        const where = pos ? ` (line ${pos.line}, column ${pos.col})` : "";
        return { path: "", message: `YAML syntax error${where}: ${firstLine(e.message)}` };
      }),
    );
  }
  return doc.toJS() ?? {};
}

function readSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === "ENOENT" ? `file not found: ${path}` : `cannot read file: ${code}`;
    throw new ConfigError(path, [{ path: "", message }]);
  }
}

function resolveProvider(
  name: string,
  provider: ProviderConfig,
  env: Record<string, string | undefined>,
  issues: ConfigIssue[],
): ResolvedProvider | undefined {
  if (provider.type !== "openai-compatible") return provider;

  const { baseUrl, baseUrlEnv, ...rest } = provider;
  if (baseUrl !== undefined) return { ...rest, baseUrl };

  const issuePath = `providers.${name}.baseUrlEnv`;
  const value = baseUrlEnv === undefined ? undefined : env[baseUrlEnv];
  if (!value) {
    issues.push({ path: issuePath, message: `environment variable ${baseUrlEnv} is not set` });
    return undefined;
  }
  if (!URL.canParse(value)) {
    issues.push({
      path: issuePath,
      message: `environment variable ${baseUrlEnv} is not a valid URL`,
    });
    return undefined;
  }
  return { ...rest, baseUrl: value };
}

/** Pretty YAML errors repeat the position and add a code frame; keep only the description. */
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, "");
}
