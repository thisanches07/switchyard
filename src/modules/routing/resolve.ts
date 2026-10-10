import type { LoadedConfig } from "../../config/load.js";

export interface ResolvedModel {
  provider: string;
  /** Model id sent upstream; may itself contain `/` (e.g. OpenRouter ids). */
  model: string;
  alias?: string;
}

type RoutingConfig = Pick<LoadedConfig, "aliases" | "providers">;

/** Splits `provider/model` on the first slash; undefined if either part is empty. */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/**
 * Resolves a client `model` to a provider. Aliases use their first candidate;
 * fallback across candidates arrives with spec 008.
 */
export function resolveModel(model: string, config: RoutingConfig): ResolvedModel | undefined {
  const alias = config.aliases[model];
  if (alias) {
    const first = alias.candidates[0];
    const ref = first === undefined ? undefined : splitModelRef(first);
    return ref ? { ...ref, alias: model } : undefined;
  }

  const ref = splitModelRef(model);
  if (!ref || !(ref.provider in config.providers)) return undefined;
  return ref;
}
