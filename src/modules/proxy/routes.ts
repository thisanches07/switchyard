import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { internalError, modelNotAllowed, modelNotFound } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import { type AuthenticateOptions, createAuthenticate } from "../auth/authenticate.js";
import { isModelAllowed } from "../auth/models.js";
import { docs } from "../docs.js";
import { listModels } from "../routing/models.js";
import { type ResolvedModel, resolveModel } from "../routing/resolve.js";
import { parseChatRequest, parseEmbeddingsRequest } from "./schema.js";
import { streamChat } from "./stream.js";
import { tracedUpstreamCall } from "./telemetry.js";

export interface ProxyRoutesOptions {
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  auth: AuthenticateOptions;
  /** Gateway start time in seconds, reported as `created` in /v1/models. */
  startedAt: number;
}

export async function proxyRoutes(app: FastifyInstance, opts: ProxyRoutesOptions): Promise<void> {
  // Every /v1 route requires a valid key (spec 004); health routes live outside this plugin.
  app.addHook("onRequest", createAuthenticate(opts.auth));

  const allowedModels = (request: FastifyRequest) => request.principal?.allowedModels ?? null;

  /** Resolves the model, checks the key may use it, picks the provider and sets headers. */
  function route(
    model: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): [ResolvedModel, ChatProvider] {
    const resolved = resolveModel(model, opts.config);
    if (!resolved) throw modelNotFound(model);
    const ref = `${resolved.provider}/${resolved.model}`;
    if (!isModelAllowed(allowedModels(request), model, ref)) throw modelNotAllowed(model);
    const provider = opts.providers.get(resolved.provider);
    if (!provider) throw internalError();
    reply.header("x-switchyard-provider", resolved.provider);
    reply.header("x-switchyard-model", resolved.model);
    return [resolved, provider];
  }

  app.get("/v1/models", { schema: docs.models }, async (request) => {
    const list = listModels(opts.config, opts.startedAt);
    const allowed = allowedModels(request);
    if (!allowed || allowed.length === 0) return list;
    const data = list.data.filter((m) => {
      const resolved = resolveModel(m.id, opts.config);
      return resolved && isModelAllowed(allowed, m.id, `${resolved.provider}/${resolved.model}`);
    });
    return { ...list, data };
  });

  app.post("/v1/chat/completions", { schema: docs.chatCompletions }, async (request, reply) => {
    const body = parseChatRequest(request.body);
    const [resolved, provider] = route(body.model, request, reply);
    const upstreamRequest = { ...body, model: resolved.model };

    if (body.stream === true) {
      return streamChat({
        reply,
        provider,
        request: upstreamRequest,
        logger: request.log,
        principal: request.principal,
      });
    }

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await tracedUpstreamCall(
        { provider, model: resolved.model, logger: request.log, principal: request.principal },
        () => provider.chat(upstreamRequest, { signal }),
      );
      return result.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  app.post("/v1/embeddings", { schema: docs.embeddings }, async (request, reply) => {
    const body = parseEmbeddingsRequest(request.body);
    const [resolved, provider] = route(body.model, request, reply);

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await tracedUpstreamCall(
        {
          provider,
          model: resolved.model,
          logger: request.log,
          operation: "embeddings",
          principal: request.principal,
        },
        () => provider.embeddings({ ...body, model: resolved.model }, { signal }),
      );
      return result.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });
}

/** Aborts the upstream call if the client goes away before we respond. */
function abortOnClientDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
