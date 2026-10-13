/**
 * OpenAPI descriptions for the routes (spec 004, AC-10). Documentation only: Zod validates and
 * responses are serialised untouched (ADR-0014), so these never filter provider payloads.
 */

import type { SwaggerOptions } from "@fastify/swagger";

const bearer = [{ bearerAuth: [] }];
const adminAuth = [{ adminToken: [] }];

/** Per-minute limit (spec 005): positive integer, or null to clear. */
const limitSchema = { type: ["integer", "null"], minimum: 1 };

/** PII redaction mode (spec 010); null uses pii.defaultMode from the config. */
const piiModeSchema = {
  type: ["string", "null"],
  enum: ["off", "mask", "block", null],
  description: "PII redaction: off, mask or block; null uses the config default",
};

/** Monthly budget in USD (spec 007): number or decimal string, at most 4 decimal places. */
const budgetSchema = {
  type: ["number", "string", "null"],
  description:
    "Monthly budget in USD (calendar month, UTC): 0 to 99999999.9999, at most 4 decimal places; null clears. Returned as a decimal string",
};

/** Soft limit of a team's budgets, percent (spec 007). */
const softLimitPctSchema = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Percent of the budget that triggers the soft-limit warning (default 80)",
};

const errorResponse = {
  description: "OpenAI-shaped error",
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        message: { type: "string" },
        type: { type: "string" },
        code: { type: "string" },
      },
    },
  },
};

/** One row of GET /admin/usage (spec 006). */
function usageRow(withGroup: boolean) {
  return {
    type: "object",
    properties: {
      ...(withGroup && {
        group: {
          type: ["string", "null"],
          description: "Team id, key id, model, provider (null: no provider reached) or date",
        },
      }),
      requests: { type: "integer" },
      inputTokens: { type: "integer" },
      outputTokens: { type: "integer" },
      costUsd: { type: "string" },
      unknownCostRequests: { type: "integer" },
    },
  };
}
const money = { type: "string", description: "USD, decimal string" };

/** GET /admin/keys|teams/:id/budget (spec 007). */
function budgetStatusDoc(scope: "key" | "team") {
  return {
    tags: ["Admin"],
    summary: `Monthly budget status of a ${scope}: limit, spend this period and flags (spec 007)`,
    security: adminAuth,
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    response: {
      200: {
        description:
          "Spend comes from the Redis counter (source: redis) or, if Redis is unavailable, from the usage tables (source: postgres)",
        type: "object",
        properties: {
          scope: { type: "string", enum: ["key", "team"] },
          id: { type: "string" },
          period: {
            type: "object",
            properties: {
              start: { type: "string", format: "date-time" },
              end: { type: "string", format: "date-time" },
            },
          },
          limitUsd: { ...money, type: ["string", "null"] },
          softLimitPct: { type: "integer" },
          spentUsd: money,
          remainingUsd: { ...money, type: ["string", "null"] },
          softLimitReached: { type: "boolean" },
          hardLimitReached: { type: "boolean" },
          unknownCostRequests: { type: "integer" },
          source: { type: "string", enum: ["redis", "postgres"] },
        },
      },
      401: errorResponse,
      404: errorResponse,
      503: errorResponse,
    },
  };
}

const anthropicErrorResponse = {
  description: "Anthropic-shaped error (spec 014)",
  type: "object",
  properties: {
    type: { type: "string", enum: ["error"] },
    error: {
      type: "object",
      properties: {
        type: { type: "string" },
        message: { type: "string" },
        details: { type: "object", properties: { error_code: { type: "string" } } },
      },
    },
    request_id: { type: "string" },
  },
};

export const openApiInfo: SwaggerOptions = {
  openapi: {
    openapi: "3.1.0",
    info: {
      title: "Switchyard",
      description:
        "Self-hosted, OpenAI-compatible LLM gateway. `/v1` routes take a Switchyard API key " +
        "(`sk-sy-…`) as a bearer token; `/admin` routes take the operator's ADMIN_TOKEN.",
      version: "0.1.0",
    },
    tags: [
      { name: "OpenAI-compatible", description: "Drop-in replacement for the OpenAI API" },
      {
        name: "Anthropic-compatible",
        description: "Anthropic Messages API for the official Anthropic SDKs (spec 014)",
      },
      { name: "Admin", description: "Teams and API keys" },
      { name: "Health" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Switchyard API key" },
        adminToken: { type: "http", scheme: "bearer", description: "ADMIN_TOKEN" },
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Switchyard API key (accepted on every /v1 route)",
        },
      },
    },
  },
};

export const docs = {
  chatCompletions: {
    tags: ["OpenAI-compatible"],
    summary: "Create a chat completion (set stream: true for SSE)",
    security: bearer,
    body: {
      type: "object",
      required: ["model", "messages"],
      additionalProperties: true,
      properties: {
        model: { type: "string", description: "Alias (e.g. `local`) or `provider/model`" },
        messages: { type: "array", items: { type: "object", additionalProperties: true } },
        stream: { type: "boolean" },
        stream_options: { type: "object", additionalProperties: true },
      },
    },
    response: { 401: errorResponse, 403: errorResponse, 404: errorResponse },
  },
  embeddings: {
    tags: ["OpenAI-compatible"],
    summary: "Create embeddings",
    security: bearer,
    body: {
      type: "object",
      required: ["model", "input"],
      additionalProperties: true,
      properties: {
        model: { type: "string" },
        input: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        encoding_format: { type: "string", enum: ["float", "base64"] },
      },
    },
  },
  messages: {
    tags: ["Anthropic-compatible"],
    summary: "Create a message (Anthropic Messages API; set stream: true for SSE)",
    description:
      "Routed like chat completions (alias or provider/model). Errors use the Anthropic shape. " +
      "Claude models get the request natively; other providers get a translation (ADR-0016).",
    security: [{ apiKeyHeader: [] }, { bearerAuth: [] }],
    body: {
      type: "object",
      required: ["model", "max_tokens", "messages"],
      additionalProperties: true,
      properties: {
        model: { type: "string", description: "Alias (e.g. `smart`) or `provider/model`" },
        max_tokens: { type: "integer", minimum: 1 },
        messages: { type: "array", items: { type: "object", additionalProperties: true } },
        system: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }],
        },
        stop_sequences: { type: "array", items: { type: "string" } },
        temperature: { type: "number" },
        top_p: { type: "number" },
        top_k: { type: "integer" },
        tools: { type: "array", items: { type: "object", additionalProperties: true } },
        tool_choice: { type: "object", additionalProperties: true },
        metadata: { type: "object", additionalProperties: true },
        stream: { type: "boolean" },
      },
    },
    response: {
      400: anthropicErrorResponse,
      401: anthropicErrorResponse,
      403: anthropicErrorResponse,
      404: anthropicErrorResponse,
      429: anthropicErrorResponse,
    },
  },
  models: {
    tags: ["OpenAI-compatible"],
    summary: "List the models this key may use",
    security: bearer,
  },
  createTeam: {
    tags: ["Admin"],
    summary: "Create a team (optional per-minute caps and monthly budget across all its keys)",
    security: adminAuth,
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        rpm: limitSchema,
        tpm: limitSchema,
        monthlyBudgetUsd: budgetSchema,
        softLimitPct: softLimitPctSchema,
      },
    },
  },
  listTeams: { tags: ["Admin"], summary: "List teams", security: adminAuth },
  createKey: {
    tags: ["Admin"],
    summary: "Create an API key (the plaintext key is returned only here)",
    security: adminAuth,
    body: {
      type: "object",
      required: ["teamId", "name"],
      properties: {
        teamId: { type: "string", format: "uuid" },
        name: { type: "string" },
        allowedModels: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Aliases, provider/model or provider/*; empty or null allows all",
        },
        expiresAt: { type: "string", format: "date-time" },
        rpm: limitSchema,
        tpm: limitSchema,
        piiMode: piiModeSchema,
        monthlyBudgetUsd: budgetSchema,
      },
    },
  },
  patchKeyLimits: {
    tags: ["Admin"],
    summary: "Set or clear (null) the per-minute limits, PII mode and monthly budget of a key",
    security: adminAuth,
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    body: {
      type: "object",
      properties: {
        rpm: limitSchema,
        tpm: limitSchema,
        piiMode: piiModeSchema,
        monthlyBudgetUsd: budgetSchema,
      },
    },
  },
  patchTeamLimits: {
    tags: ["Admin"],
    summary: "Set or clear (null) the per-minute caps and monthly budget of a team",
    security: adminAuth,
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    body: {
      type: "object",
      properties: {
        rpm: limitSchema,
        tpm: limitSchema,
        monthlyBudgetUsd: budgetSchema,
        softLimitPct: softLimitPctSchema,
      },
    },
  },
  listKeys: {
    tags: ["Admin"],
    summary: "List API keys (never returns keys or hashes)",
    security: adminAuth,
    querystring: {
      type: "object",
      properties: { teamId: { type: "string", format: "uuid" } },
    },
  },
  revokeKey: {
    tags: ["Admin"],
    summary: "Revoke an API key (idempotent)",
    security: adminAuth,
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  usage: {
    tags: ["Admin"],
    summary: "Usage per team, key, model, provider or day (spec 006; eventually consistent)",
    security: adminAuth,
    querystring: {
      type: "object",
      properties: {
        from: {
          type: "string",
          format: "date",
          description: "UTC date, inclusive (default: to − 29 days)",
        },
        to: { type: "string", format: "date", description: "UTC date, inclusive (default: today)" },
        groupBy: {
          type: "string",
          enum: ["team", "key", "model", "provider", "day"],
          default: "day",
        },
        teamId: { type: "string", format: "uuid" },
        keyId: { type: "string", format: "uuid" },
      },
    },
    response: {
      200: {
        description: "Usage rows and totals; costUsd sums known costs only (decimal string)",
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          groupBy: { type: "string" },
          data: { type: "array", items: usageRow(true) },
          totals: usageRow(false),
        },
      },
      400: errorResponse,
      401: errorResponse,
    },
  },
  keyBudget: budgetStatusDoc("key"),
  teamBudget: budgetStatusDoc("team"),
  health: { tags: ["Health"], summary: "Liveness / readiness probe" },
};
