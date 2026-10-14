import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../../../src/core/chat.js";
import { canonicalJson, exactKey, paramsHash } from "../../../src/modules/cache/key.js";

const TEAM = "6f1c2b8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
const OTHER_TEAM = "0c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
const CANDIDATE = "mock/fast-model";

const base = (): ChatRequest => ({
  model: "fast",
  temperature: 0,
  max_tokens: 50,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "What is 2 + 2?" },
  ],
});

const key = (request: ChatRequest, team = TEAM, candidate = CANDIDATE) =>
  exactKey(team, candidate, request);

describe("canonicalJson (ADR-0019)", () => {
  it("sorts keys by code unit at every level and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    // Code-unit order, independent of locale: uppercase before lowercase, "_" between.
    expect(canonicalJson({ b: 1, B: 2, _: 3, a: 4 })).toBe('{"B":2,"_":3,"a":4,"b":1}');
  });

  it("writes numbers in their shortest form and keeps strings byte for byte", () => {
    expect(canonicalJson({ t: 1.0, u: 0.1, s: " Hé́ " })).toBe('{"s":" Hé́ ","t":1,"u":0.1}');
  });

  it("keeps nested nulls", () => {
    expect(canonicalJson({ a: { b: null } })).toBe('{"a":{"b":null}}');
  });
});

describe("exactKey (spec 009, ADR-0019)", () => {
  it("is prefixed with version, team and candidate and ends in a SHA-256", () => {
    expect(key(base())).toMatch(
      new RegExp(`^sy:cache:exact:v1:${TEAM}:${CANDIDATE}:[0-9a-f]{64}$`),
    );
  });

  it("ignores key order, model, stream, stream_options, user, metadata, store, service_tier", () => {
    const a = base();
    const b: ChatRequest = {
      messages: a.messages,
      max_tokens: 50,
      temperature: 0,
      model: "other-alias",
      stream: true,
      stream_options: { include_usage: true },
      user: "u-1",
      metadata: { tag: "x" },
      store: false,
      service_tier: "auto",
    };
    expect(key(b)).toBe(key(a));
  });

  it("treats n: 1 as absent", () => {
    expect(key({ ...base(), n: 1 })).toBe(key(base()));
  });

  it("removes null fields at the top level and in messages, not deeper", () => {
    const withNulls: ChatRequest = {
      ...base(),
      seed: null,
      messages: [
        { role: "system", content: "Be brief.", name: null },
        { role: "user", content: "What is 2 + 2?" },
      ],
    };
    expect(key(withNulls)).toBe(key(base()));
    const nested = (value: unknown) =>
      key({
        ...base(),
        response_format: { type: "json_schema", json_schema: { name: "x", schema: value } },
      });
    expect(nested({ default: null })).not.toBe(nested({}));
  });

  it("is scoped by team and candidate", () => {
    expect(key(base(), OTHER_TEAM)).not.toBe(key(base()));
    expect(key(base(), TEAM, "ollama/llama3.2")).not.toBe(key(base()));
    // The team is inside the hash too, not only in the prefix.
    const hashOf = (k: string) => k.slice(k.lastIndexOf(":") + 1);
    expect(hashOf(key(base(), OTHER_TEAM))).not.toBe(hashOf(key(base())));
  });

  it.each<[string, (r: ChatRequest) => ChatRequest]>([
    ["max_tokens", (r) => ({ ...r, max_tokens: 51 })],
    ["temperature", (r) => ({ ...r, temperature: 0.1 })],
    ["absent temperature", ({ temperature: _t, ...r }) => r as ChatRequest],
    ["response_format", (r) => ({ ...r, response_format: { type: "json_object" } })],
    [
      "system prompt",
      (r) => ({
        ...r,
        messages: [
          { role: "system", content: "Be long." },
          r.messages[1],
        ] as ChatRequest["messages"],
      }),
    ],
    [
      "user message",
      (r) => ({
        ...r,
        messages: [
          r.messages[0],
          { role: "user", content: "What is 2+2?" },
        ] as ChatRequest["messages"],
      }),
    ],
    ["message order", (r) => ({ ...r, messages: [...r.messages].reverse() })],
    ["tools", (r) => ({ ...r, tools: [{ type: "function", function: { name: "f" } }] })],
    ["stop", (r) => ({ ...r, stop: ["b", "a"] })],
    ["unknown parameter", (r) => ({ ...r, future_param: true })],
    ["n: 2", (r) => ({ ...r, n: 2 })],
  ])("changes when %s changes", (_name, change) => {
    expect(key(change(base()))).not.toBe(key(base()));
  });

  it("keeps stop sequence order significant", () => {
    expect(key({ ...base(), stop: ["a", "b"] })).not.toBe(key({ ...base(), stop: ["b", "a"] }));
  });
});

describe("paramsHash (ADR-0009, ADR-0019)", () => {
  const withQuestion = (question: string): ChatRequest => ({
    ...base(),
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: question },
    ],
  });

  it("ignores the final user message but not the earlier turns", () => {
    expect(paramsHash(withQuestion("What is 2 + 2?"))).toBe(paramsHash(withQuestion("2+2=?")));
    const otherSystem = withQuestion("2+2=?");
    otherSystem.messages[0] = { role: "system", content: "Be long." };
    expect(paramsHash(otherSystem)).not.toBe(paramsHash(withQuestion("2+2=?")));
  });

  it("changes with output-affecting parameters and ignores the excluded ones", () => {
    expect(paramsHash({ ...base(), max_tokens: 10 })).not.toBe(paramsHash(base()));
    expect(paramsHash({ ...base(), stream: true, user: "u" })).toBe(paramsHash(base()));
  });

  it("is a 64-character hex SHA-256 without team or model", () => {
    expect(paramsHash(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsHash({ ...base(), model: "another" })).toBe(paramsHash(base()));
  });
});
