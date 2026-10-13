import { describe, expect, it } from "vitest";
import {
  isBrazilianDdd,
  isCnpj,
  isCpf,
  isEmailDomain,
  isIpAddress,
  luhn,
} from "../../../src/modules/pii/validators.js";

describe("PII validators (spec 010)", () => {
  it.each([
    ["4111111111111111", true],
    ["4111 1111 1111 1111", true],
    ["5500-0000-0000-0004", true],
    ["4111111111111112", false],
    ["0000000000000000", false], // passes Luhn, rejected as repeated digits
    ["411111111111", false], // 12 digits: too short
    ["41111111111111111111", false], // 20 digits: too long
  ])("luhn(%s) = %s", (value, valid) => {
    expect(luhn(value)).toBe(valid);
  });

  it.each([
    ["529.982.247-25", true],
    ["52998224725", true],
    ["529.982.247-26", false],
    ["52998224726", false],
    ["111.111.111-11", false],
    ["00000000000", false],
    ["11987654321", false],
    ["5299822472", false],
  ])("isCpf(%s) = %s", (value, valid) => {
    expect(isCpf(value)).toBe(valid);
  });

  it.each([
    ["11.222.333/0001-81", true],
    ["11222333000181", true],
    ["11.222.333/0001-82", false],
    ["00000000000000", false],
    ["11111111111111", false],
    // Alphanumeric CNPJ (2026): check digits over charCode - 48.
    ["12.ABC.345/01DE-35", true],
    ["12ABC34501DE35", true],
    ["12ABC34501DE36", false],
    ["12abc34501de35", false], // lower case is not a valid CNPJ
    ["12ABC34501DEAB", false], // check digits are always numeric
  ])("isCnpj(%s) = %s", (value, valid) => {
    expect(isCnpj(value)).toBe(valid);
  });

  it.each([
    ["11", true],
    ["21", true],
    ["99", true],
    ["52", false],
    ["10", false],
    ["00", false],
    ["20", false],
  ])("isBrazilianDdd(%s) = %s", (ddd, valid) => {
    expect(isBrazilianDdd(ddd)).toBe(valid);
  });

  it.each([
    ["example.com", true],
    ["mail.example.com.br", true],
    ["a-b.io", true],
    ["localhost", false],
    ["example.c", false],
    ["example.123", false],
    ["-example.com", false],
    ["example-.com", false],
    ["example..com", false],
    [`${"a".repeat(64)}.com`, false],
  ])("isEmailDomain(%s) = %s", (domain, valid) => {
    expect(isEmailDomain(domain)).toBe(valid);
  });

  it.each([
    ["192.168.0.1", true],
    ["0.0.0.0", true],
    ["2001:db8::1", true],
    ["::ffff:192.168.0.1", true],
    ["2001:0db8:0000:0000:0000:ff00:0042:8329", true],
    ["999.1.1.1", false],
    ["256.0.0.1", false],
    ["12:30:45", false],
    ["::", false],
    ["1.2.3", false],
  ])("isIpAddress(%s) = %s", (value, valid) => {
    expect(isIpAddress(value)).toBe(valid);
  });
});
