import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigError } from "../../../src/config/errors.js";
import { parseConfig } from "../../../src/config/load.js";
import { configSchema } from "../../../src/config/schema.js";
import { formatPath } from "../../../src/config/zod-issues.js";
import { noHealthyUpstream } from "../../../src/core/errors.js";

const examplePath = resolve(import.meta.dirname, "../../../config/switchyard.example.yaml");
const exampleText = () => readFileSync(examplePath, "utf8");
const example = (): Record<string, unknown> => parse(exampleText());
const env = { OLLAMA_BASE_URL: "http://host.docker.internal:11434/v1" };

function issues(input: unknown) {
  const result = configSchema.safeParse(input);
  if (result.success) throw new Error("expected validation to fail");
  return result.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
}

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected ConfigError");
}

describe("routing section (spec 008, AC-1)", () => {
  it("defaults ewmaAlpha to 0.3 and hotReload to true", () => {
    const config = example();
    delete config.routing;
    expect(configSchema.parse(config).routing).toEqual({ ewmaAlpha: 0.3, hotReload: true });
  });

  it.each([0, -0.1, 1.5])("rejects ewmaAlpha %s", (ewmaAlpha) => {
    const config = { ...example(), routing: { ewmaAlpha } };
    expect(issues(config)[0]?.path).toBe("routing.ewmaAlpha");
  });

  it("accepts ewmaAlpha 1 and hotReload false", () => {
    const config = { ...example(), routing: { ewmaAlpha: 1, hotReload: false } };
    expect(configSchema.parse(config).routing).toEqual({ ewmaAlpha: 1, hotReload: false });
  });

  it("rejects unknown routing keys", () => {
    const config = { ...example(), routing: { exploration: 0.1 } };
    expect(issues(config)[0]?.message).toMatch(/exploration/);
  });
});

describe("parseConfig (spec 008)", () => {
  it("validates YAML text like loadConfig does", () => {
    const config = parseConfig(exampleText(), "inline.yaml", env);
    expect(config.aliases.local?.candidates).toEqual(["ollama/llama3.2"]);
    expect(config.routing.ewmaAlpha).toBeGreaterThan(0);
  });

  it("reports syntax and schema errors with the given source", () => {
    const syntax = configError(() => parseConfig("a: [", "inline.yaml", env));
    expect(syntax.source).toBe("inline.yaml");
    expect(syntax.issues[0]?.message).toMatch(/YAML syntax error/);
    const schema = configError(() => parseConfig("providers: {}\nroutes: 1\n", "x.yaml", env));
    expect(schema.issues[0]?.message).toMatch(/routes/);
  });
});

describe("noHealthyUpstream (spec 008, AC-9)", () => {
  it("is a 503 server_error with retry-after in whole seconds", () => {
    const error = noHealthyUpstream(7);
    expect(error.status).toBe(503);
    expect(error.toBody().error).toMatchObject({
      type: "server_error",
      code: "no_healthy_upstream",
    });
    expect(error.headers).toEqual({ "retry-after": "7" });
  });

  it("never advertises less than 1 second and rounds up", () => {
    expect(noHealthyUpstream(0).headers["retry-after"]).toBe("1");
    expect(noHealthyUpstream(2.2).headers["retry-after"]).toBe("3");
  });
});
