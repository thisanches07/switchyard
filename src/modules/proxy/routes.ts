import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { internalError, modelNotAllowed, modelNotFound } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import { type AuthenticateOptions, createAuthenticate } from "../auth/authenticate.js";
import { isModelAllowed } from "../auth/models.js";
import { docs } from "../docs.js";
import type { Admission, AdmissionService } from "../ratelimit/admission.js";
import { estimateChatTokens, estimateEmbeddingTokens } from "../ratelimit/estimate.js";
import { listModels } from "../routing/models.js";
import { type ResolvedModel, resolveModel } from "../routing/resolve.js";
import { parseChatRequest, parseEmbeddingsRequest } from "./schema.js";
import { streamChat } from "./stream.js";
import { tracedUpstreamCall } from "./telemetry.js";

export interface ProxyRoutesOptions {
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  auth: AuthenticateOptions;
  admission: AdmissionService;
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

  /** Rate-limit admission (spec 005); sets x-ratelimit-* headers or throws 429/400/503. */
  async function admit(request: FastifyRequest, reply: FastifyReply, estimate: number) {
    if (!request.principal) return undefined;
    const admission = await opts.admission.admit(request.principal, estimate);
    reply.headers(admission.headers);
    return admission;
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
    const admission = await admit(
      request,
      reply,
      estimateChatTokens(body, opts.config.limits.completionReserveTokens),
    );

    if (body.stream === true) {
      return streamChat({
        reply,
        provider,
        request: upstreamRequest,
        logger: request.log,
        principal: request.principal,
        admission,
      });
    }

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await settle(
        admission,
        tracedUpstreamCall(
          { provider, model: resolved.model, logger: request.log, principal: request.principal },
          () => provider.chat(upstreamRequest, { signal }),
        ),
        (r) => r.usage && r.usage.inputTokens + r.usage.outputTokens,
      );
      return result.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  app.post("/v1/embeddings", { schema: docs.embeddings }, async (request, reply) => {
    const body = parseEmbeddingsRequest(request.body);
    const [resolved, provider] = route(body.model, request, reply);
    const admission = await admit(request, reply, estimateEmbeddingTokens(body.input));

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await settle(
        admission,
        tracedUpstreamCall(
          {
            provider,
            model: resolved.model,
            logger: request.log,
            operation: "embeddings",
            principal: request.principal,
          },
          () => provider.embeddings({ ...body, model: resolved.model }, { signal }),
        ),
        (r) => r.usage?.inputTokens,
      );
      return result.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });
}

/**
 * Reconciles the token reservation once a non-streaming call settles (spec 005, AC-6):
 * real usage on success (the reservation is kept when the provider reports none),
 * a full refund on failure.
 */
async function settle<T>(
  admission: Admission | undefined,
  call: Promise<T>,
  usedTokens: (result: T) => number | undefined,
): Promise<T> {
  try {
    const result = await call;
    await admission?.reconcile(usedTokens(result) ?? admission.reservedTokens);
    return result;
  } catch (error) {
    await admission?.reconcile(undefined);
    throw error;
  }
}

/** Aborts the upstream call if the client goes away before we respond. */
function abortOnClientDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
