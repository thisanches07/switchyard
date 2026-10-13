import { describe, expect, it } from "vitest";
import { GatewayError } from "../../../src/core/errors.js";
import { MemoryKeyStore } from "../../helpers/memory-key-store.js";

describe("MemoryKeyStore (test double for KeyStore)", () => {
  it("rejects duplicate team names with 409", async () => {
    const store = new MemoryKeyStore();
    await store.createTeam("a");
    await expect(store.createTeam("a")).rejects.toBeInstanceOf(GatewayError);
  });

  it("revokes idempotently and never exposes hashes", async () => {
    const store = new MemoryKeyStore();
    const { record } = await store.issueKey();
    const first = await store.revokeKey(record.id);
    const second = await store.revokeKey(record.id);
    expect(first?.status).toBe("revoked");
    expect(second?.revokedAt).toEqual(first?.revokedAt);
    expect(Object.keys((await store.listKeys())[0] ?? {})).not.toContain("hash");
    expect(await store.revokeKey("missing")).toBeUndefined();
  });

  it("stores the PII mode (null by default) and patches it without touching limits", async () => {
    const store = new MemoryKeyStore();
    const { record } = await store.issueKey({ limits: { rpm: 5 } });
    expect(record.piiMode).toBeNull();
    const { record: masked } = await store.issueKey({ piiMode: "mask" });
    expect(masked.piiMode).toBe("mask");

    expect(await store.updateKeyLimits(record.id, { piiMode: "block" })).toMatchObject({
      piiMode: "block",
      rpm: 5,
    });
    expect(await store.updateKeyLimits(record.id, { rpm: 7 })).toMatchObject({
      piiMode: "block",
      rpm: 7,
    });
    expect(await store.updateKeyLimits(record.id, { piiMode: null })).toMatchObject({
      piiMode: null,
    });
    const found = await store.findKeyByHash([...store.keys.values()][0]?.hash ?? "");
    expect(found?.key.piiMode).toBeNull();
  });

  it("stores budgets (spec 007): null by default, team soft limit 80 %, patch and clear", async () => {
    const store = new MemoryKeyStore();
    const { record, team } = await store.issueKey({ limits: { rpm: 5 } });
    expect(record.monthlyBudgetUsd).toBeNull();
    expect(team).toMatchObject({ monthlyBudgetUsd: null, softLimitPct: 80 });
    expect(await store.getKey(record.id)).toEqual(record);
    expect(await store.getKey("missing")).toBeUndefined();

    expect(await store.updateKeyLimits(record.id, { monthlyBudgetUsd: "10" })).toMatchObject({
      monthlyBudgetUsd: "10",
      rpm: 5,
    });
    expect(await store.updateKeyLimits(record.id, { monthlyBudgetUsd: null })).toMatchObject({
      monthlyBudgetUsd: null,
    });
    expect(
      await store.updateTeamLimits(team.id, { monthlyBudgetUsd: "1.5", softLimitPct: 50 }),
    ).toMatchObject({ monthlyBudgetUsd: "1.5", softLimitPct: 50 });
    const created = await store.createTeam("with-budget", {
      monthlyBudgetUsd: "3",
      softLimitPct: 90,
    });
    expect(created).toMatchObject({ monthlyBudgetUsd: "3", softLimitPct: 90 });
  });
});
