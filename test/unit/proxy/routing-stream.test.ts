import { afterEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../../../src/config/load.js";
import { upstreamError } from "../../../src/core/errors.js";
import type { ChatProvider } from "../../../src/core/provider.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { testApp } from "../../helpers/app.js";
import { testConfig } from "../../helpers/config.js";
import { spiedRegistry } from "../../helpers/providers.js";

const messages = [{ role: "user", content: "hello" }];

function config(overrides: Record<string, unknown> = {}): LoadedConfig {
  return testConfig({
    aliases: {
      resilient: { strategy: "priority", candidates: ["mock/error-503", "ollama/llama3.2"] },
      flaky: { strategy: "priority", candidates: ["mock/error-midstream", "ollama/llama3.2"] },
      broken: { strategy: "priority", candidates: ["mock/error-500"] },
    },
    ...overrides,
  });
}

/** `data:` payloads of an SSE body, without `[DONE]`. */
const dataEvents = (body: string) =>
  body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);

describe("streaming routing (spec 008, AC-6)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(
    options: { config?: LoadedConfig; providers?: Map<string, ChatProvider> } = {},
  ) {
    const { registry, spies } = spiedRegistry();
    const events: UsageEvent[] = [];
    const { app } = await testApp({
      config: options.config ?? config(),
      providers: options.providers ?? registry,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    const stream = (model: string) =>
      app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model, messages, stream: true },
      });
    return { spies, events, stream };
  }

  const lastEvent = (events: UsageEvent[]) => {
    const event = events.at(-1) as UsageEvent;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    return event;
  };

  it("falls back before the first chunk and sends one clean stream", async () => {
    const { stream, spies, events } = await setup();
    const res = await stream("resilient");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.headers["x-switchyard-provider"]).toBe("ollama");
    expect(res.headers["x-switchyard-model"]).toBe("llama3.2");
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    const chunks = dataEvents(res.body);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks.every((c) => c.model === "llama3.2")).toBe(true);
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(spies.mock?.requests.map((r) => r.model)).toEqual(["error-503"]);
    expect(lastEvent(events)).toMatchObject({
      outcome: "success",
      stream: true,
      provider: "ollama",
      attempts: 2,
    });
  });

  it("a failure while reading the first chunk is still retried", async () => {
    const { registry, spies } = spiedRegistry();
    const failingFirst: ChatProvider = {
      ...(registry.get("mock") as ChatProvider),
      chatStream: async () =>
        (async function* () {
          yield* [];
          throw upstreamError("mock");
        })(),
    };
    registry.set("mock", failingFirst);
    const { stream } = await setup({ providers: registry });
    const res = await stream("resilient");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-attempts"]).toBe("2");
    expect(spies.ollama?.requests).toHaveLength(1);
  });

  it("a failure after the first chunk is not retried and counts against the breaker (ADR-0008)", async () => {
    const { stream, spies, events } = await setup({
      config: config({ circuitBreaker: { failureThreshold: 1, openMs: 60_000 } }),
    });
    const res = await stream("flaky");
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-switchyard-provider"]).toBe("mock");
    expect(res.headers["x-switchyard-attempts"]).toBe("1");
    const chunks = dataEvents(res.body);
    expect(chunks.at(-1)).toMatchObject({ error: { code: "upstream_error" } });
    expect(res.body).not.toContain("[DONE]");
    expect(spies.ollama?.requests).toHaveLength(0);
    expect(lastEvent(events)).toMatchObject({
      outcome: "upstream_error_midstream",
      attempts: 1,
      provider: "mock",
    });

    // The mid-stream failure opened mock/error-midstream's breaker: the next request skips it.
    const next = await stream("flaky");
    expect(next.headers["x-switchyard-provider"]).toBe("ollama");
    expect(next.headers["x-switchyard-attempts"]).toBe("1");
  });

  it("returns a JSON error with routing headers when every attempt fails before the first chunk", async () => {
    const { stream, events } = await setup();
    const res = await stream("broken");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("upstream_error");
    expect(res.headers["x-switchyard-attempts"]).toBe("3");
    expect(res.headers["x-switchyard-model"]).toBe("error-500");
    expect(lastEvent(events)).toMatchObject({ outcome: "upstream_error", attempts: 3 });
  });
});
