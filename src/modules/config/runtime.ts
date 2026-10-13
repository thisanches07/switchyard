/**
 * The live configuration (spec 008, ADR-0018): an immutable snapshot that every request reads
 * once at its start, and a reload routine that validates the file and swaps in a new snapshot
 * for new requests. An invalid file never replaces a valid one.
 */
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { ConfigError } from "../../config/errors.js";
import { type LoadedConfig, parseConfig, readSource } from "../../config/load.js";
import type { ChatProvider } from "../../core/provider.js";
import { stableJson } from "../../core/stable-json.js";
import { countConfigReload } from "../routing/telemetry.js";

export interface ConfigSnapshot {
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
}

export interface ReloadResult {
  result: "reloaded" | "unchanged";
  /** Settings bound at startup whose value changed in the file; the old value is kept. */
  restartRequired: string[];
}

export interface ConfigRuntime {
  current(): ConfigSnapshot;
  /** Re-reads the config file. Throws `ConfigError` (previous snapshot kept) when invalid. */
  reload(): ReloadResult;
  onChange(listener: (prev: LoadedConfig, next: LoadedConfig) => void): void;
}

export interface ConfigRuntimeDeps {
  initial: ConfigSnapshot;
  /** The config file and the environment its `*Env` settings resolve from; none = static. */
  source?: { path: string; env: Record<string, string | undefined> } | undefined;
  buildProviders(config: LoadedConfig): ReadonlyMap<string, ChatProvider>;
  logger: Pick<FastifyBaseLogger, "info" | "warn">;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Settings bound when the process starts (Fastify options, the undici agent, the auth hook, the
 * usage publisher, spec 007's pricing file). A reload keeps their old values and names the ones
 * whose value changed (spec 008, AC-12; design §8).
 */
export function pinStartupSettings(
  prev: LoadedConfig,
  next: LoadedConfig,
): { config: LoadedConfig; restartRequired: string[] } {
  const pinned: [string, unknown, unknown][] = [
    ["server.bodyLimitBytes", prev.server.bodyLimitBytes, next.server.bodyLimitBytes],
    ["server.trustProxy", prev.server.trustProxy, next.server.trustProxy],
    ["server.timeouts.connectMs", prev.server.timeouts.connectMs, next.server.timeouts.connectMs],
    [
      "limits.authFailuresPerMinutePerIp",
      prev.limits.authFailuresPerMinutePerIp,
      next.limits.authFailuresPerMinutePerIp,
    ],
    ["usage", prev.usage, next.usage],
    ["pricingFile", prev.pricingFile, next.pricingFile],
  ];
  const restartRequired = pinned
    .filter(([, before, after]) => stableJson(before) !== stableJson(after))
    .map(([path]) => path);
  const config: LoadedConfig = {
    ...next,
    server: {
      ...next.server,
      bodyLimitBytes: prev.server.bodyLimitBytes,
      trustProxy: prev.server.trustProxy,
      timeouts: { ...next.server.timeouts, connectMs: prev.server.timeouts.connectMs },
    },
    limits: { ...next.limits, authFailuresPerMinutePerIp: prev.limits.authFailuresPerMinutePerIp },
    usage: prev.usage,
    pricingFile: prev.pricingFile,
  };
  return { config, restartRequired };
}

export function createConfigRuntime(deps: ConfigRuntimeDeps): ConfigRuntime {
  let snapshot = deps.initial;
  const listeners: ((prev: LoadedConfig, next: LoadedConfig) => void)[] = [];
  const { source, logger } = deps;
  /** Hash of the content behind the active snapshot; a failed file never becomes active. */
  let activeHash = source ? safeHash(source.path) : undefined;

  /** Provider instances whose definition did not change are kept (and their state with them). */
  function providersFor(prev: ConfigSnapshot, config: LoadedConfig) {
    const built = deps.buildProviders(config);
    const merged = new Map<string, ChatProvider>();
    for (const [name, provider] of built) {
      const same = stableJson(prev.config.providers[name]) === stableJson(config.providers[name]);
      merged.set(name, (same && prev.providers.get(name)) || provider);
    }
    return merged;
  }

  return {
    current: () => snapshot,

    reload() {
      if (!source) return { result: "unchanged", restartRequired: [] };
      let parsed: LoadedConfig;
      let hash: string;
      try {
        const text = readSource(source.path);
        hash = sha256(text);
        if (hash === activeHash) return { result: "unchanged", restartRequired: [] };
        parsed = parseConfig(text, source.path, source.env);
      } catch (error) {
        countConfigReload("failure");
        if (error instanceof ConfigError) {
          // Paths and messages only: config values (and anything secret-looking) never reach logs.
          logger.warn(
            { source: error.source, issues: error.issues },
            "config reload failed: keeping the previous config",
          );
        }
        throw error;
      }

      const prev = snapshot;
      const { config, restartRequired } = pinStartupSettings(prev.config, parsed);
      snapshot = { config, providers: providersFor(prev, config) };
      activeHash = hash;
      for (const listener of listeners) listener(prev.config, config);
      countConfigReload("success");
      if (restartRequired.length > 0) {
        logger.warn(
          { settings: restartRequired },
          "config reload: these settings need a restart to change",
        );
      }
      logger.info({ source: source.path }, "config reloaded");
      return { result: "reloaded", restartRequired };
    },

    onChange(listener) {
      listeners.push(listener);
    },
  };
}

function safeHash(path: string): string | undefined {
  try {
    return sha256(readSource(path));
  } catch {
    return undefined;
  }
}
