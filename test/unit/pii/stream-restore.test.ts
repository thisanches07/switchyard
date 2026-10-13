import { describe, expect, it } from "vitest";
import {
  createTextRestorer,
  type HoldEvent,
  type HoldLimits,
  indexPlaceholders,
} from "../../../src/modules/pii/stream-restore.js";

const CPF = "529.982.247-25";
const MAP = new Map([
  ["<CPF_1>", CPF],
  ["<EMAIL_1>", "ana@example.com"],
  ["<TERM_1>", 'say "hi" \\ now'],
]);
const INDEX = indexPlaceholders(MAP);
const LIMITS: HoldLimits = { maxHoldMs: 250 };

function textRestorer(limits: HoldLimits = LIMITS, json = false) {
  const events: HoldEvent[] = [];
  const restorer = createTextRestorer({
    index: INDEX,
    limits,
    json,
    onHold: (e) => events.push(e),
  });
  return { restorer, events };
}

/** Pushes every piece at time 0 and flushes; returns what each push sent and the joined text. */
function run(pieces: string[], limits: HoldLimits = LIMITS) {
  const { restorer, events } = textRestorer(limits);
  const sent = pieces.map((piece) => restorer.push(piece, 0));
  sent.push(restorer.flush(0));
  return { sent, text: sent.join(""), events };
}

/** True when `piece` ends with a proper prefix of a known placeholder (a partial placeholder). */
const endsPartial = (piece: string) =>
  [...MAP.keys()].some((key) => {
    for (let n = 1; n < key.length; n++) if (piece.endsWith(key.slice(0, n))) return true;
    return false;
  });

describe("stream text restorer (spec 015)", () => {
  const TEXT = "Your CPF <CPF_1> is registered.";
  const RESTORED = `Your CPF ${CPF} is registered.`;
  const start = TEXT.indexOf("<");
  const end = start + "<CPF_1>".length;
  // Every split from `<|CPF_1>` (just before the `<`) to `<CPF_1|>` (just before the `>`)...
  const splits = Array.from({ length: end - start + 1 }, (_, k) => start + k);

  it.each(splits)("restores a placeholder split into two chunks at %i (AC-2)", (at) => {
    const { sent, text } = run([TEXT.slice(0, at), TEXT.slice(at)]);
    expect(text).toBe(RESTORED);
    for (const piece of sent) expect(endsPartial(piece), piece).toBe(false);
  });

  it("restores a placeholder sent one character per chunk (AC-2)", () => {
    const { sent, text, events } = run([...TEXT]);
    expect(text).toBe(RESTORED);
    for (const piece of sent) expect(endsPartial(piece), piece).toBe(false);
    expect(events).toEqual([{ heldMs: 0, outcome: "restored" }]);
  });

  it("restores a placeholder split across three or more chunks (AC-2)", () => {
    expect(run(["CPF <C", "PF", "_", "1> and mail <EMA", "IL_1>."]).text).toBe(
      `CPF ${CPF} and mail ana@example.com.`,
    );
  });

  it("restores several placeholders in one chunk and back to back", () => {
    expect(run(["<CPF_1><EMAIL_1>", " <CPF_1"]).text).toBe(`${CPF}ana@example.com <CPF_1`);
    expect(run(["<CPF_1", "><CPF", "_1>"]).text).toBe(`${CPF}${CPF}`);
  });

  it("sends text without `<` at once, unchanged (AC-4)", () => {
    const { sent } = run(["Hello", " world", ""]);
    expect(sent).toEqual(["Hello", " world", "", ""]);
  });

  it.each([
    ["unknown", ["CPF <CPF_", "9> ok"], "CPF <CPF_9> ok"],
    ["lower case", ["CPF <cp", "f_1>"], "CPF <cpf_1>"],
    ["spaced", ["< CPF_1 >"], "< CPF_1 >"],
    ["lone `<`", ["a < b", " and <", " c"], "a < b and < c"],
    ["`<` then a placeholder", ["<<CPF_1>"], `<${CPF}`],
    ["unclosed then another", ["<CPF_1 <CPF_1>"], `<CPF_1 ${CPF}`],
    ["dash", ["<CPF-1>"], "<CPF-1>"],
  ])(
    "forwards placeholder-shaped text that is not known unchanged: %s (AC-3)",
    (_n, pieces, expected) => {
      expect(run(pieces).text).toBe(expected);
    },
  );

  it("releases a fragment at the character that rules it out (AC-3)", () => {
    const { restorer, events } = textRestorer();
    expect(restorer.push("CPF <CPF_", 0)).toBe("CPF ");
    expect(restorer.push("9", 10)).toBe("<CPF_9");
    expect(restorer.deadline()).toBeUndefined();
    expect(events).toEqual([{ heldMs: 10, outcome: "ruled_out" }]);
    expect(restorer.push("<", 20)).toBe("");
    expect(restorer.push(" x", 30)).toBe("< x");
  });

  it("inserts JSON-escaped values in argument slots", () => {
    const { restorer } = textRestorer(LIMITS, true);
    const out = restorer.push('{"t":"<TERM', 0) + restorer.push('_1>"}', 0) + restorer.flush(0);
    expect(JSON.parse(out)).toEqual({ t: MAP.get("<TERM_1>") });
  });

  it("never holds more than maxHoldChars characters (AC-4)", () => {
    const { restorer, events } = textRestorer({ maxHoldMs: 250, maxHoldChars: 3 });
    expect(restorer.push("a <CPF", 0)).toBe("a <CPF");
    expect(restorer.push("_1>", 0)).toBe("_1>");
    expect(restorer.push("b <C", 5)).toBe("b ");
    expect(restorer.push("PF_1>", 5)).toBe(CPF);
    expect(events.map((e) => e.outcome)).toEqual(["hold_limit", "restored"]);
  });

  it("releases a fragment held for maxHoldMs, unrestored (AC-4)", () => {
    const { restorer, events } = textRestorer();
    expect(restorer.push("CPF <CP", 1000)).toBe("CPF ");
    expect(restorer.deadline()).toBe(1250);
    expect(restorer.expire(1249)).toBe("");
    expect(restorer.push("F", 1100)).toBe("");
    // The hold started at the first held character: growing it does not extend the deadline.
    expect(restorer.deadline()).toBe(1250);
    expect(restorer.expire(1250)).toBe("<CPF");
    expect(restorer.deadline()).toBeUndefined();
    expect(restorer.push("_1>", 1300)).toBe("_1>");
    expect(events).toEqual([{ heldMs: 250, outcome: "hold_limit" }]);
  });

  it("releases on push when the hold limit passed without an expiry", () => {
    const { restorer, events } = textRestorer();
    restorer.push("<CP", 0);
    expect(restorer.push("F", 300)).toBe("<CPF");
    expect(events).toEqual([{ heldMs: 300, outcome: "hold_limit" }]);
  });

  it("flushes the held fragment as-is at the end of the text", () => {
    const { restorer, events } = textRestorer();
    restorer.push("end <EMAIL", 0);
    expect(restorer.flush(40)).toBe("<EMAIL");
    expect(restorer.flush(50)).toBe("");
    expect(events).toEqual([{ heldMs: 40, outcome: "end" }]);
  });

  it("records the held time of a restored placeholder", () => {
    const { restorer, events } = textRestorer();
    restorer.push("<CPF", 100);
    restorer.push("_", 130);
    expect(restorer.push("1>", 170)).toBe(CPF);
    expect(events).toEqual([{ heldMs: 70, outcome: "restored" }]);
  });
});
