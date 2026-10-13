import { describe, expect, it } from "vitest";
import { shutdownTelemetry, startTelemetry } from "../../../src/infra/telemetry/sdk.js";

describe("telemetry sdk", () => {
  it("does not start when OTEL_SDK_DISABLED=true", () => {
    expect(startTelemetry({ OTEL_SDK_DISABLED: "true" })).toBe(false);
  });

  it("shutdownTelemetry resolves when SDK not started", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
