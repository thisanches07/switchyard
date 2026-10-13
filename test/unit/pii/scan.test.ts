import { describe, expect, it } from "vitest";
import { PII_TYPES, type PiiType } from "../../../src/core/pii.js";
import { createScanner } from "../../../src/modules/pii/scan.js";

const scanAll = createScanner({ types: [...PII_TYPES], denyList: ["Acme", "Project Falcon"] });

/** Detections as `[type, matched text]` pairs, in order. */
const found = (text: string, scan = scanAll) =>
  scan(text).map((d) => [d.type, text.slice(d.start, d.end)]);

describe("PII scanner: true positives (spec 010, AC-3)", () => {
  it.each<[string, PiiType]>([
    ["ana.silva@example.com", "email"],
    ["(11) 98765-4321", "phone"],
    ["+55 11 98765-4321", "phone"],
    ["11987654321", "phone"],
    ["+14155552671", "phone"],
    ["4111 1111 1111 1111", "card"],
    ["4111111111111111", "card"],
    ["529.982.247-25", "cpf"],
    ["52998224725", "cpf"],
    ["11.222.333/0001-81", "cnpj"],
    ["11222333000181", "cnpj"],
    ["12.ABC.345/01DE-35", "cnpj"],
    ["12ABC34501DE35", "cnpj"],
    ["192.168.0.1", "ip"],
    ["2001:db8::1", "ip"],
    ["::ffff:192.168.0.1", "ip"],
    ["acme", "term"],
    ["ACME", "term"],
    ["project falcon", "term"],
  ])("finds %s as %s inside a sentence", (vector, type) => {
    for (const text of [vector, `Hi, it is ${vector}, thanks.`, `(${vector})`, `${vector}.`]) {
      expect(found(text), text).toEqual([[type, vector]]);
    }
  });

  it("finds several values in order with exact boundaries", () => {
    const text = "CPF 529.982.247-25, mail ana.silva@example.com; call +14155552671 from 10.0.0.7";
    expect(found(text)).toEqual([
      ["cpf", "529.982.247-25"],
      ["email", "ana.silva@example.com"],
      ["phone", "+14155552671"],
      ["ip", "10.0.0.7"],
    ]);
  });

  it("trims trailing punctuation from e-mail domains and IPv6 addresses", () => {
    expect(found("write to ana@example.com.")).toEqual([["email", "ana@example.com"]]);
    expect(found("host 2001:db8::1.")).toEqual([["ip", "2001:db8::1"]]);
  });
});

describe("PII scanner: false positives (spec 010, AC-4)", () => {
  it.each([
    "4111 1111 1111 1112",
    "529.982.247-26",
    "52998224726",
    "111.111.111-11",
    "00000000000",
    "11.222.333/0001-82",
    "999.1.1.1",
    "256.0.0.1",
    "12:30:45",
    "acmeville",
  ])("does not report %s", (vector) => {
    for (const text of [vector, `value ${vector} here`]) {
      expect(found(text), text).toEqual([]);
    }
  });

  it.each([
    ["a CPF inside a longer number", "1529982247251"],
    ["an e-mail without a real domain", "user@localhost"],
    ["a version string", "v1.2.3.4"],
    ["a C++ scope", "std::vector"],
    ["a MAC address", "00:1A:2B:3C:4D:5E"],
    ["the unspecified IPv6 address", "a :: b"],
    ["a lower-case alphanumeric CNPJ", "12abc34501de35"],
    ["a term inside a word", "acmes and macme"],
    ["an order id with no valid area code", "5212345678"],
  ])("does not report %s", (_label, text) => {
    expect(found(text)).toEqual([]);
  });
});

describe("PII scanner: configuration", () => {
  it("runs only the configured detector types", () => {
    const onlyEmail = createScanner({ types: ["email"], denyList: ["acme"] });
    expect(found("ana@example.com 529.982.247-25 acme", onlyEmail)).toEqual([
      ["email", "ana@example.com"],
    ]);
    const noTerms = createScanner({ types: ["cpf"], denyList: ["acme"] });
    expect(found("acme", noTerms)).toEqual([]);
  });

  it("matches deny-list terms literally, never as regular expressions", () => {
    const scan = createScanner({ types: ["term"], denyList: ["a.c", "C++", "(x)"] });
    expect(found("abc and a.c", scan)).toEqual([["term", "a.c"]]);
    expect(found("we use c++ here", scan)).toEqual([["term", "c++"]]);
    expect(found("call (X) now", scan)).toEqual([["term", "(X)"]]);
  });

  it("respects Unicode word boundaries in deny-list terms", () => {
    const scan = createScanner({ types: ["term"], denyList: ["João"] });
    expect(found("Fale com JOÃO hoje", scan)).toEqual([["term", "JOÃO"]]);
    expect(found("Joãozinho", scan)).toEqual([]);
  });

  it("returns nothing for empty text", () => {
    expect(scanAll("")).toEqual([]);
  });
});

describe("PII scanner: overlaps (spec 010, AC-5)", () => {
  it("reports an 11-digit number as CPF only when it passes the CPF check", () => {
    expect(found("52998224725")).toEqual([["cpf", "52998224725"]]);
    expect(found("11987654321")).toEqual([["phone", "11987654321"]]);
  });

  it("prefers a validator-backed type over a pattern-only one of the same length", () => {
    // A valid CPF that is also a well-formed mobile number (DDD 11, starts with 9).
    const cpfShapedLikePhone = findCpfShapedLikePhone();
    expect(found(cpfShapedLikePhone)).toEqual([["cpf", cpfShapedLikePhone]]);
    const phoneOnly = createScanner({ types: ["phone"], denyList: [] });
    expect(found(cpfShapedLikePhone, phoneOnly)).toEqual([["phone", cpfShapedLikePhone]]);
  });

  it("keeps the longest match and replaces each character at most once", () => {
    expect(found("ana@acme.com")).toEqual([["email", "ana@acme.com"]]);
    expect(found("+5511987654321")).toEqual([["phone", "+5511987654321"]]);
    const detections = scanAll("x 4111 1111 1111 1111 y ::ffff:192.168.0.1 z");
    expect(detections.map((d) => d.type)).toEqual(["card", "ip"]);
    for (let i = 1; i < detections.length; i += 1) {
      expect(detections[i]?.start).toBeGreaterThanOrEqual(detections[i - 1]?.end ?? 0);
    }
  });

  it("prefers a CNPJ over a card number when both validate", () => {
    // A 14-digit CNPJ whose digits also pass Luhn: check digits are the more specific signal.
    const scan = createScanner({ types: ["card", "cnpj"], denyList: [] });
    const cnpjPassingLuhn = findCnpjPassingLuhn();
    expect(found(cnpjPassingLuhn, scan)).toEqual([["cnpj", cnpjPassingLuhn]]);
  });
});

/** First valid CPF of the form 119xxxxxxxx (a valid São Paulo mobile number shape). */
function findCpfShapedLikePhone(): string {
  const cpfOnly = createScanner({ types: ["cpf"], denyList: [] });
  for (let n = 10_000_000; n < 100_000_000; n += 1) {
    const value = `119${n}`;
    if (cpfOnly(value).length === 1) return value;
  }
  throw new Error("no vector found");
}

/** Smallest numeric CNPJ (base 000000010001-xx and up) whose 14 digits also pass Luhn. */
function findCnpjPassingLuhn(): string {
  const cardOnly = createScanner({ types: ["card"], denyList: [] });
  const cnpjOnly = createScanner({ types: ["cnpj"], denyList: [] });
  for (let base = 10_001; base < 10_000_000; base += 1) {
    for (let dv = 0; dv < 100; dv += 1) {
      const value = `${String(base).padStart(12, "0")}${String(dv).padStart(2, "0")}`;
      if (cnpjOnly(value).length === 1) {
        if (cardOnly(value).length === 1) return value;
        break;
      }
    }
  }
  throw new Error("no vector found");
}
