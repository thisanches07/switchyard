/**
 * OpenAPI descriptions for the routes (spec 004, AC-10). Documentation only: Zod validates and
 * responses are serialised untouched (ADR-0014), so these never filter provider payloads.
 */

import type { SwaggerOptions } from "@fastify/swagger";

const bearer = [{ bearerAuth: [] }];
const adminAuth = [{ adminToken: [] }];

/** Per-minute limit (spec 005): positive integer, or null to clear. */
const limitSchema = { type: ["integer", "null"], minimum: 1 };

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
      { name: "Admin", description: "Teams and API keys" },
      { name: "Health" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Switchyard API key" },
        adminToken: { type: "http", scheme: "bearer", description: "ADMIN_TOKEN" },
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
  models: {
    tags: ["OpenAI-compatible"],
    summary: "List the models this key may use",
    security: bearer,
  },
  createTeam: {
    tags: ["Admin"],
    summary: "Create a team (optional per-minute caps across all its keys)",
    security: adminAuth,
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        rpm: limitSchema,
        tpm: limitSchema,
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
      },
    },
  },
  patchKeyLimits: {
    tags: ["Admin"],
    summary: "Set or clear (null) the per-minute limits of a key",
    security: adminAuth,
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    body: { type: "object", properties: { rpm: limitSchema, tpm: limitSchema } },
  },
  patchTeamLimits: {
    tags: ["Admin"],
    summary: "Set or clear (null) the per-minute caps of a team",
    security: adminAuth,
    params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    body: { type: "object", properties: { rpm: limitSchema, tpm: limitSchema } },
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
  health: { tags: ["Health"], summary: "Liveness / readiness probe" },
};
