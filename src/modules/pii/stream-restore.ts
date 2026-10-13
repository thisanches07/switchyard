/**
 * Restoring placeholders in streamed answers (spec 015).
 *
 * Pure state machines: time is always a parameter (`now`, epoch ms), so every split position and
 * every hold limit can be tested without a clock. Text that cannot start a known placeholder is
 * returned at once; a fragment that still could (`<`, `<CP`, `<CPF_`) is held until it completes,
 * is ruled out, or a hold limit is reached, and is then released as-is (ADR-0015: best effort).
 */
import type { RestoreMap } from "./placeholder.js";

/** The restore map of one request, with what streaming needs precomputed. */
export interface PlaceholderIndex {
  map: RestoreMap;
  /** Every proper prefix of every placeholder (`<`, `<C`, … `<CPF_1`). */
  prefixes: ReadonlySet<string>;
  /** Length of the longest placeholder. */
  longest: number;
}

export function indexPlaceholders(map: RestoreMap): PlaceholderIndex {
  const prefixes = new Set<string>();
  let longest = 0;
  for (const key of map.keys()) {
    longest = Math.max(longest, key.length);
    for (let n = 1; n < key.length; n++) prefixes.add(key.slice(0, n));
  }
  return { map, prefixes, longest };
}

export interface HoldLimits {
  maxHoldMs: number;
  /** Default: the longest placeholder (a held fragment is always shorter, so it never fires). */
  maxHoldChars?: number | undefined;
}

/** How a hold ended: completed and restored, ruled out, released at a limit, or end of text. */
export type HoldOutcome = "restored" | "ruled_out" | "hold_limit" | "end";

export interface HoldEvent {
  heldMs: number;
  outcome: HoldOutcome;
}

export type HoldListener = (event: HoldEvent) => void;

/** One text slot: a choice's `content`, or one tool call's `arguments`. */
export interface TextRestorer {
  /** Restored text that can be sent now (possibly `""` when everything is held). */
  push(text: string, now: number): string;
  /** The held fragment, unrestored, if it has been held for `maxHoldMs`; else `""`. */
  expire(now: number): string;
  /** Whatever is held, unrestored (end of the slot's text). */
  flush(now: number): string;
  /** When the held fragment must be released, or undefined when nothing is held. */
  deadline(): number | undefined;
}

export interface TextRestorerOptions {
  index: PlaceholderIndex;
  limits: HoldLimits;
  /** Insert values JSON-escaped (tool-call arguments are JSON text). */
  json?: boolean;
  onHold?: HoldListener | undefined;
}

export function createTextRestorer({
  index,
  limits,
  json = false,
  onHold,
}: TextRestorerOptions): TextRestorer {
  const maxChars = limits.maxHoldChars ?? index.longest;
  let held = "";
  let heldSince = 0;

  const value = (key: string): string | undefined => {
    const original = index.map.get(key);
    if (original === undefined) return undefined;
    return json ? JSON.stringify(original).slice(1, -1) : original;
  };

  const end = (outcome: HoldOutcome, now: number) => {
    onHold?.({ heldMs: Math.max(0, now - heldSince), outcome });
  };

  /** Releases the held fragment unrestored. */
  const release = (outcome: HoldOutcome, now: number): string => {
    if (held === "") return "";
    const out = held;
    end(outcome, now);
    held = "";
    return out;
  };

  return {
    push(text, now) {
      if (text === "") return "";
      if (held === "" && !text.includes("<")) return text;
      const buffer = held + text;
      const wasHolding = held !== "";
      let out = "";
      let i = 0;
      let tail = "";
      let tailAt = -1;
      while (i < buffer.length) {
        const at = buffer.indexOf("<", i);
        if (at < 0) {
          out += buffer.slice(i);
          break;
        }
        out += buffer.slice(i, at);
        const close = buffer.indexOf(">", at + 1);
        if (close >= 0 && close - at < index.longest) {
          const restored = value(buffer.slice(at, close + 1));
          if (restored !== undefined) {
            if (wasHolding && at === 0) end("restored", now);
            out += restored;
            i = close + 1;
            continue;
          }
        }
        if (
          close < 0 &&
          buffer.length - at < index.longest &&
          index.prefixes.has(buffer.slice(at))
        ) {
          tail = buffer.slice(at);
          tailAt = at;
          break;
        }
        // Cannot become a known placeholder: the `<` goes out as written.
        if (wasHolding && at === 0) end("ruled_out", now);
        out += "<";
        i = at + 1;
      }

      const continuing = wasHolding && tailAt === 0;
      if (!continuing) heldSince = now;
      held = tail;
      if (held !== "" && (held.length > maxChars || now - heldSince >= limits.maxHoldMs)) {
        out += release("hold_limit", now);
      }
      return out;
    },

    expire(now) {
      if (held === "" || now < heldSince + limits.maxHoldMs) return "";
      return release("hold_limit", now);
    },

    flush: (now) => release("end", now),

    deadline: () => (held === "" ? undefined : heldSince + limits.maxHoldMs),
  };
}
