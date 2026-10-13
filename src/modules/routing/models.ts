import type { LoadedConfig } from "../../config/load.js";
import { splitModelRef } from "./resolve.js";

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelObject[];
}

/** OpenAI-style model list: aliases first, then each distinct `provider/model` candidate. */
export function listModels(config: Pick<LoadedConfig, "aliases">, created: number): ModelList {
  const data: ModelObject[] = Object.keys(config.aliases).map((id) => ({
    id,
    object: "model",
    created,
    owned_by: "switchyard",
  }));

  const seen = new Set<string>();
  for (const alias of Object.values(config.aliases)) {
    for (const ref of alias.candidates) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      data.push({
        id: ref,
        object: "model",
        created,
        owned_by: splitModelRef(ref)?.provider ?? "unknown",
      });
    }
  }
  return { object: "list", data };
}
