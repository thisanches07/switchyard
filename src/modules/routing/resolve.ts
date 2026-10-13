import type { LoadedConfig } from "../../config/load.js";

export interface ResolvedModel {
  provider: string;
  /** Model id sent upstream; may itself contain `/` (e.g. OpenRouter ids). */
  model: string;
  alias?: string;
}

type RoutingConfig = Pick<LoadedConfig, "aliases" | "providers">;

export type RoutingStrategy = LoadedConfig["aliases"][string]["strategy"];

/** One `provider/model` a request may be served by (spec 008). */
export interface Candidate {
  /** `provider/model`, the key of its breaker and latency state. */
  ref: string;
  provider: string;
  /** Model id sent upstream; may itself contain `/`. */
  model: string;
}

export interface RoutePlan {
  /** The model the client sent. */
  requested: string;
  alias?: string;
  strategy: RoutingStrategy;
  /** In config order; a plain `provider/model` has exactly one. */
  candidates: Candidate[];
}

const toCandidate = (ref: string): Candidate | undefined => {
  const split = splitModelRef(ref);
  return split && { ref, ...split };
};

/** Every distinct `provider/model` listed by the aliases, in config order. */
export function aliasCandidates(aliases: RoutingConfig["aliases"]): string[] {
  return [...new Set(Object.values(aliases).flatMap((alias) => alias.candidates))];
}

/** Every candidate a client `model` may be served by (spec 008, AC-1); undefined if unknown. */
export function planRoute(model: string, config: RoutingConfig): RoutePlan | undefined {
  const alias = config.aliases[model];
  if (alias) {
    const candidates = alias.candidates.flatMap((ref) => toCandidate(ref) ?? []);
    if (candidates.length === 0) return undefined;
    return { requested: model, alias: model, strategy: alias.strategy, candidates };
  }
  const candidate = toCandidate(model);
  if (!candidate || !(candidate.provider in config.providers)) return undefined;
  return { requested: model, strategy: "priority", candidates: [candidate] };
}

/** Splits `provider/model` on the first slash; undefined if either part is empty. */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/**
 * Resolves a client `model` to one provider: an alias's first candidate. Requests are routed with
 * `planRoute` (every candidate, spec 008); this is kept for single-target lookups.
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
