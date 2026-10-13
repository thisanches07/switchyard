import { describe, expect, it } from "vitest";
import type { ChatChunk } from "../../../src/core/chat.js";
import {
  createChunkRestorer,
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

const ID = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 7, model: "m" };
const chunk = (choices: unknown[], extra: object = {}): ChatChunk => ({ ...ID, choices, ...extra });
const content = (text: string, index = 0, finish: string | null = null) => ({
  index,
  delta: { content: text },
  finish_reason: finish,
});
const args = (text: string, tool = 0, index = 0) => ({
  index,
  delta: { tool_calls: [{ index: tool, function: { arguments: text } }] },
  finish_reason: null,
});

function chunkRestorer(limits: HoldLimits = LIMITS) {
  const events: HoldEvent[] = [];
  const restorer = createChunkRestorer({ index: INDEX, limits, onHold: (e) => events.push(e) });
  return { restorer, events };
}

/** Joined `delta.content` of a choice, and joined `arguments` per tool call, over chunks. */
function textOf(chunks: ChatChunk[], choice = 0) {
  let text = "";
  const tools = new Map<number, string>();
  for (const c of chunks) {
    for (const ch of (c.choices as Record<string, unknown>[] | undefined) ?? []) {
      if (ch.index !== choice) continue;
      const delta = ch.delta as {
        content?: string;
        tool_calls?: { index: number; function?: { arguments?: string } }[];
      };
      text += delta?.content ?? "";
      for (const call of delta?.tool_calls ?? []) {
        tools.set(call.index, (tools.get(call.index) ?? "") + (call.function?.arguments ?? ""));
      }
    }
  }
  return { text, tools };
}

describe("stream chunk restorer (spec 015)", () => {
  it("restores content and tool-call arguments per choice and tool index (AC-1)", () => {
    const { restorer } = chunkRestorer();
    const upstream = [
      chunk([content("CPF <CP", 0)]),
      chunk([content("mail <EMAIL", 1)]),
      chunk([args('{"a":"<TER', 0, 0)]),
      chunk([args('{"b":"<CPF_', 1, 0)]),
      chunk([content("F_1>.", 0), content("_1>.", 1)]),
      chunk([args('M_1>"}', 0, 0)]),
      chunk([args('1>"}', 1, 0)]),
    ];
    const out = upstream.flatMap((c) => restorer.chunk(c, 0));
    expect(out).toHaveLength(upstream.length);
    expect(textOf(out, 0).text).toBe(`CPF ${CPF}.`);
    expect(textOf(out, 1).text).toBe("mail ana@example.com.");
    const tools = textOf(out, 0).tools;
    expect(JSON.parse(tools.get(0) ?? "")).toEqual({ a: MAP.get("<TERM_1>") });
    expect(JSON.parse(tools.get(1) ?? "")).toEqual({ b: CPF });
    expect(restorer.deadline()).toBeUndefined();
  });

  it("keeps chunk boundaries and fields, sending an empty string while text is held", () => {
    const { restorer } = chunkRestorer();
    const first = chunk([{ index: 0, delta: { role: "assistant", content: "<" }, logprobs: null }]);
    const [out] = restorer.chunk(first, 0);
    expect(out).toEqual({
      ...ID,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null }],
    });
    // The upstream chunk is not mutated.
    expect(first.choices).toEqual([
      { index: 0, delta: { role: "assistant", content: "<" }, logprobs: null },
    ]);
  });

  it("releases held text in a synthesised chunk before the finish chunk (AC-6)", () => {
    const { restorer } = chunkRestorer();
    restorer.chunk(chunk([content("x <CPF", 0)]), 0);
    restorer.chunk(chunk([args("<EMA", 2, 0)]), 0);
    const finish = chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
    const out = restorer.chunk(finish, 5);
    expect(out).toEqual([
      {
        ...ID,
        choices: [
          {
            index: 0,
            delta: { content: "<CPF", tool_calls: [{ index: 2, function: { arguments: "<EMA" } }] },
            finish_reason: null,
          },
        ],
      },
      finish,
    ]);
  });

  it("puts held text in the finish chunk's own field when it carries one (AC-6)", () => {
    const { restorer } = chunkRestorer();
    restorer.chunk(chunk([content("<CPF_1", 0)]), 0);
    const out = restorer.chunk(chunk([content("> and <", 0, "stop")]), 0);
    expect(out).toEqual([chunk([content(`${CPF} and <`, 0, "stop")])]);
  });

  it("only flushes the finishing choice", () => {
    const { restorer } = chunkRestorer();
    restorer.chunk(chunk([content("<CP", 0), content("<EM", 1)]), 0);
    const out = restorer.chunk(chunk([{ index: 1, delta: {}, finish_reason: "stop" }]), 0);
    expect(textOf(out, 1).text).toBe("<EM");
    expect(textOf(out, 0).text).toBe("");
    expect(restorer.deadline()).toBe(250);
  });

  it("flushes everything before a usage chunk (AC-6)", () => {
    const { restorer } = chunkRestorer();
    restorer.chunk(chunk([content("<CP", 0)]), 0);
    const usage = { ...ID, choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } };
    const out = restorer.chunk(usage, 0);
    expect(out).toHaveLength(2);
    expect(textOf(out).text).toBe("<CP");
    expect(out[1]).toBe(usage);
  });

  it("synthesises expired and flushed fragments with the stream's identity (AC-4)", () => {
    const { restorer, events } = chunkRestorer();
    restorer.chunk(chunk([content("a <CPF", 0)]), 100);
    restorer.chunk({ ...chunk([content("b <EMAIL_", 1)]), id: "chatcmpl-2" }, 200);
    expect(restorer.deadline()).toBe(350);
    expect(restorer.expire(349)).toEqual([]);
    expect(restorer.expire(350)).toEqual([
      {
        ...ID,
        id: "chatcmpl-2",
        choices: [{ index: 0, delta: { content: "<CPF" }, finish_reason: null }],
      },
    ]);
    expect(restorer.deadline()).toBe(450);
    expect(textOf(restorer.flush(400), 1).text).toBe("<EMAIL_");
    expect(restorer.flush(400)).toEqual([]);
    expect(events.map((e) => e.outcome)).toEqual(["hold_limit", "end"]);
  });

  it("passes malformed chunks and choices through", () => {
    const { restorer } = chunkRestorer();
    const odd: ChatChunk[] = [
      { ...ID },
      chunk(["x", null, { index: 0 }, { index: 0, delta: { content: 5 } }]),
      chunk([{ delta: { tool_calls: ["x", { function: { arguments: 1 } }, { id: "t" }] } }]),
    ];
    for (const c of odd) expect(restorer.chunk(c, 0).at(-1)).toEqual(c);
  });
});
