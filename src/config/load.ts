import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { ConfigError, type ConfigIssue } from "./errors.js";
import { type AppConfig, configSchema, type ProviderConfig } from "./schema.js";
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
  const raw = readSource(path);

  const doc = parseDocument(raw);
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

  const result = configSchema.safeParse(doc.toJS() ?? {});
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
