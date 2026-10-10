import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          env: { OTEL_SDK_DISABLED: "true" },
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.int.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 180_000,
          env: { OTEL_SDK_DISABLED: "true" },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html"],
      // Spec 002 AC-12: business logic must stay covered by unit tests.
      thresholds: {
        "src/core/**": { lines: 80 },
        "src/modules/**": { lines: 80 },
      },
    },
  },
});
