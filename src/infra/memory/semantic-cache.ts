import { randomUUID } from "node:crypto";
import type {
  NewSemanticEntry,
  SemanticCacheStore,
  SemanticMatch,
  SemanticScope,
} from "../../core/cache.js";

interface Entry extends NewSemanticEntry {
  id: string;
  hits: number;
}

/** Cosine similarity; 0 when either vector is all zeros. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * In-process semantic cache with exact (brute-force) cosine search and the scope and expiry rules
 * of the Postgres store (spec 009). For unit tests; production uses pgvector.
 */
export class MemorySemanticCache implements SemanticCacheStore {
  readonly #entries: Entry[] = [];
  /** When true every call rejects, like an unreachable Postgres. */
  failing = false;

  /** Stored entries (tests inspect them). */
  get entries(): readonly Readonly<Entry>[] {
    return this.#entries;
  }

  async nearest(
    scope: SemanticScope,
    embedding: readonly number[],
    now: Date,
  ): Promise<SemanticMatch | undefined> {
    this.#check();
    let best: SemanticMatch | undefined;
    for (const entry of this.#entries) {
      if (
        entry.teamId !== scope.teamId ||
        entry.paramsHash !== scope.paramsHash ||
        !scope.models.includes(entry.model) ||
        entry.expiresAt.getTime() <= now.getTime()
      ) {
        continue;
      }
      const similarity = cosineSimilarity(entry.embedding, embedding);
      if (!best || similarity > best.similarity) {
        best = { id: entry.id, model: entry.model, response: entry.response, similarity };
      }
    }
    return best;
  }

  async insert(entry: NewSemanticEntry): Promise<void> {
    this.#check();
    this.#entries.push({ ...entry, embedding: [...entry.embedding], id: randomUUID(), hits: 0 });
  }

  async recordHit(id: string): Promise<void> {
    this.#check();
    const entry = this.#entries.find((e) => e.id === id);
    if (entry) entry.hits += 1;
  }

  async deleteExpired(now: Date): Promise<number> {
    this.#check();
    let deleted = 0;
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      if ((this.#entries[i] as Entry).expiresAt.getTime() <= now.getTime()) {
        this.#entries.splice(i, 1);
        deleted += 1;
      }
    }
    return deleted;
  }

  #check(): void {
    if (this.failing) throw new Error("semantic cache unavailable");
  }
}
