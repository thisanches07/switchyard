/**
 * What `pnpm demo:traffic` sends (spec 011, AC-10): a configurable mix of requests to the `mock`
 * provider only. Pure, so the mix and the "mock only" rule are unit-tested.
 */

export const REQUEST_KINDS = ["chat", "stream", "embeddings", "repeat", "error", "burst"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type Mix = Record<RequestKind, number>;

export interface TrafficOptions {
  durationSeconds: number;
  /** Request groups started per second. */
  rps: number;
  mix: Mix;
}

export interface PlannedRequest {
  kind: RequestKind;
  path: "/v1/chat/completions" | "/v1/embeddings";
  body: Record<string, unknown>;
  /** `limited`: the low-rpm key, for the rate-limit burst. */
  key: "main" | "limited";
}

/** Weights per slot. A burst slot sends BURST_SIZE requests, so it is rare by default. */
export const DEFAULT_MIX: Mix = {
  chat: 8,
  stream: 4,
  embeddings: 2,
  repeat: 3,
  error: 1,
  burst: 0.25,
};

/** Requests per burst on the limited key (its rpm is below this, so some get 429). */
export const BURST_SIZE = 6;

const PROMPTS = [
  "Summarise the benefits of an LLM gateway in one sentence.",
  "Write a haiku about load balancing.",
  "List three uses of a circuit breaker.",
  "Explain token budgets to a new engineer.",
  "What does time to first token measure?",
];
/** Forced upstream failures of the mock provider (before or after the first byte). */
const ERROR_MODELS = [
  "mock/error-500",
  "mock/error-503",
  "mock/error-429",
  "mock/error-400",
  "mock/error-midstream",
];

const message = (content: string) => [{ role: "user", content }];
const pick = <T>(items: readonly T[], random: () => number) =>
  items[Math.floor(random() * items.length)] as T;

/** The request(s) of one planned slot. Only `mock/*` model refs, never a paid provider. */
export function planRequests(
  kind: RequestKind,
  index: number,
  random: () => number,
): PlannedRequest[] {
  const chat = (body: Record<string, unknown>, key: PlannedRequest["key"] = "main") => ({
    kind,
    path: "/v1/chat/completions" as const,
    body,
    key,
  });
  switch (kind) {
    case "chat":
      return [chat({ model: "mock/demo", messages: message(pick(PROMPTS, random)) })];
    case "stream":
      return [
        chat({
          model: "mock/demo",
          stream: true,
          stream_options: { include_usage: true },
          messages: message(pick(PROMPTS, random)),
        }),
      ];
    case "embeddings":
      return [
        {
          kind,
          path: "/v1/embeddings",
          body: { model: "mock/embed", input: pick(PROMPTS, random) },
          key: "main",
        },
      ];
    case "repeat":
      // Identical every time: served from the cache where caching is enabled (spec 009).
      return [chat({ model: "mock/demo", messages: message("What is Switchyard?") })];
    case "error": {
      const model = ERROR_MODELS[index % ERROR_MODELS.length] as string;
      return [chat({ model, stream: model === "mock/error-midstream", messages: message("hi") })];
    }
    case "burst":
      return Array.from({ length: BURST_SIZE }, () =>
        chat({ model: "mock/demo", messages: message("burst") }, "limited"),
      );
  }
}

/** A kind drawn with probability proportional to its weight in the mix. */
export function pickKind(mix: Mix, random: () => number): RequestKind {
  const total = REQUEST_KINDS.reduce((sum, kind) => sum + mix[kind], 0);
  let point = random() * total;
  for (const kind of REQUEST_KINDS) {
    point -= mix[kind];
    if (point < 0 && mix[kind] > 0) return kind;
  }
  return REQUEST_KINDS.findLast((kind) => mix[kind] > 0) ?? "chat";
}

function positive(name: string, value: string | undefined): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`--${name} must be a positive number (got "${value}")`);
  }
  return number;
}

function parseMix(value: string | undefined): Mix {
  const mix = Object.fromEntries(REQUEST_KINDS.map((kind) => [kind, 0])) as Mix;
  for (const entry of (value ?? "").split(",").filter(Boolean)) {
    const [kind = "", weight] = entry.split("=");
    if (!(REQUEST_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`unknown request kind "${kind}" (known: ${REQUEST_KINDS.join(", ")})`);
    }
    const number = Number(weight);
    if (!Number.isFinite(number) || number < 0) throw new Error(`bad weight in --mix "${entry}"`);
    mix[kind as RequestKind] = number;
  }
  if (REQUEST_KINDS.every((kind) => mix[kind] === 0)) {
    throw new Error("--mix needs at least one kind with a positive weight");
  }
  return mix;
}

/** `--duration 300 --rps 4 --mix chat=8,stream=4,...` (also `--name=value`). */
export function parseTrafficArgs(argv: readonly string[]): TrafficOptions {
  const options: TrafficOptions = { durationSeconds: 300, rps: 4, mix: DEFAULT_MIX };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--duration") options.durationSeconds = positive("duration", value());
    else if (flag === "--rps") options.rps = positive("rps", value());
    else if (flag === "--mix") options.mix = parseMix(value());
    else throw new Error(`unknown option "${arg}" (use --duration, --rps, --mix)`);
  }
  return options;
}
