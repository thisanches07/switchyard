import { afterEach, describe, expect, it } from "vitest";
import type { PiiMode } from "../../../src/core/pii.js";
import { type UsageEvent, usageEventSchema } from "../../../src/core/usage.js";
import { MemoryRateLimiter } from "../../../src/infra/memory/rate-limiter.js";
import { testApp } from "../../helpers/app.js";
import { spiedRegistry } from "../../helpers/providers.js";

const CPF = "529.982.247-25";
const EMAIL = "ana.silva@example.com";

describe("PII in usage events (spec 010, AC-13 with spec 006's outcome hook)", () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(mode: PiiMode) {
    const events: UsageEvent[] = [];
    const { registry, spies } = spiedRegistry();
    const { app, store } = await testApp({
      providers: registry,
      limiter: new MemoryRateLimiter(),
      authenticated: false,
      usageRecorder: { record: (event) => events.push(event) },
    });
    apps.push(app);
    const { key } = await store.issueKey({ team: `usage-${mode}`, piiMode: mode });
    const send = (url: string, payload: object) =>
      app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${key}` } });
    const chat = (content: string, extra: object = {}) =>
      send("/v1/chat/completions", {
        model: "fast",
        messages: [{ role: "user", content }],
        ...extra,
      });
    return { events, spies, send, chat };
  }

  /** Exactly one valid event, carrying no detected value. */
  const only = (events: UsageEvent[]) => {
    expect(events).toHaveLength(1);
    const event = events[0] as UsageEvent;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    const bytes = JSON.stringify(event);
    for (const value of [CPF, EMAIL, "52998224725"]) expect(bytes).not.toContain(value);
    return event;
  };

  it("counts detections per type on a masked request", async () => {
    const { events, chat } = await setup("mask");
    const res = await chat(`${CPF} and ${CPF}, mail ${EMAIL}`);
    expect(res.statusCode).toBe(200);
    expect(only(events)).toMatchObject({
      outcome: "success",
      provider: "mock",
      piiDetections: { cpf: 2, email: 1 },
    });
  });

  it("counts detections on a masked stream", async () => {
    const { events, chat } = await setup("mask");
    const res = await chat(`cpf ${CPF}`, { stream: true });
    expect(res.statusCode).toBe(200);
    expect(only(events)).toMatchObject({ outcome: "success", piiDetections: { cpf: 1 } });
  });

  it.each<[PiiMode, string]>([
    ["off", `cpf ${CPF}`],
    ["mask", "nothing personal"],
  ])("records {} with mode %s and %j", async (mode, content) => {
    const { events, chat } = await setup(mode);
    expect((await chat(content)).statusCode).toBe(200);
    expect(only(events).piiDetections).toEqual({});
  });

  it.each([
    ["chat", "/v1/chat/completions", { model: "fast", messages: [{ role: "user", content: "" }] }],
    [
      "streaming chat",
      "/v1/chat/completions",
      { model: "fast", stream: true, messages: [{ role: "user", content: "" }] },
    ],
    ["embeddings", "/v1/embeddings", { model: "mock/e", input: "" }],
  ])("records one rejected event for a blocked %s", async (_label, url, template) => {
    const { events, spies, send } = await setup("block");
    const text = `mail ${EMAIL} cpf ${CPF}`;
    const payload = structuredClone(template) as Record<string, unknown>;
    if ("messages" in payload) payload.messages = [{ role: "user", content: text }];
    else payload.input = text;

    const res = await send(url, payload);
    expect(res.statusCode).toBe(400);
    expect(only(events)).toMatchObject({
      outcome: "rejected",
      status: 400,
      errorCode: "pii_detected",
      provider: null,
      servedModel: null,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      piiDetections: { cpf: 1, email: 1 },
    });
    expect(spies.mock?.requests).toHaveLength(0);
    expect(spies.mock?.embeddingRequests).toHaveLength(0);
  });
});
