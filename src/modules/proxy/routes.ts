import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { internalError, modelNotAllowed, modelNotFound } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import type { UsageOperation } from "../../core/usage.js";
import { type AuthenticateOptions, createAuthenticate } from "../auth/authenticate.js";
import { isModelAllowed } from "../auth/models.js";
import { docs } from "../docs.js";
import { restoreChatResponse } from "../pii/restore.js";
import { createPiiStage } from "../pii/stage.js";
import type { Admission, AdmissionService } from "../ratelimit/admission.js";
import { estimateChatTokens, estimateEmbeddingTokens } from "../ratelimit/estimate.js";
import { listModels } from "../routing/models.js";
import { type ResolvedModel, resolveModel } from "../routing/resolve.js";
import {
  type OutcomeHook,
  type OutcomeTracker,
  registerOutcomeFallback,
  type TokenUsage,
} from "../usage/outcome.js";
import { registerMessagesRoute } from "./messages.js";
import { parseChatRequest, parseEmbeddingsRequest } from "./schema.js";
import { streamChat } from "./stream.js";
import { tracedUpstreamCall } from "./telemetry.js";
import { estimateChatUsage } from "./usage.js";

export interface ProxyRoutesOptions {
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  auth: AuthenticateOptions;
  admission: AdmissionService;
  /** Request-outcome hook (spec 006): one usage event per admitted request. */
  outcomes: OutcomeHook;
  /** Gateway start time in seconds, reported as `created` in /v1/models. */
  startedAt: number;
}

export async function proxyRoutes(app: FastifyInstance, opts: ProxyRoutesOptions): Promise<void> {
  // Every /v1 route requires a valid key (spec 004); health routes live outside this plugin.
  app.addHook("onRequest", createAuthenticate(opts.auth));

  const allowedModels = (request: FastifyRequest) => request.principal?.allowedModels ?? null;
  // PII mask/block (spec 010): after admission, before the cache and any provider.
  const pii = createPiiStage(opts.config.pii);

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

  /**
   * Rate-limit admission (spec 005); sets x-ratelimit-* headers or throws 429/400/503.
   * An admitted request starts its outcome tracker (spec 006): from here on it yields one event.
   */
  async function admit(
    request: FastifyRequest,
    reply: FastifyReply,
    estimate: number,
    usage: { operation: UsageOperation; stream: boolean; model: string; resolved: ResolvedModel },
  ) {
    if (!request.principal) return undefined;
    const admission = await opts.admission.admit(request.principal, estimate);
    reply.headers(admission.headers);
    opts.outcomes.begin(request, {
      requestId: request.id,
      principal: request.principal,
      operation: usage.operation,
      stream: usage.stream,
      requestedModel: usage.model,
      provider: usage.resolved.provider,
      servedModel: usage.resolved.model,
      elapsedMs: () => reply.elapsedTime,
    });
    return admission;
  }

  // Records any admitted request whose route did not end its tracker (spec 006).
  registerOutcomeFallback(app);

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
    const stream = body.stream === true;
    const admission = await admit(
      request,
      reply,
      estimateChatTokens(body, opts.config.limits.completionReserveTokens),
      { operation: "chat", stream, model: body.model, resolved },
    );
    const masked = await pii.chat({ request, reply, admission, stream }, body);
    const upstreamRequest = { ...masked.body, model: resolved.model };

    if (stream) {
      return streamChat({
        reply,
        provider,
        request: upstreamRequest,
        logger: request.log,
        principal: request.principal,
        admission,
        outcome: request.outcome,
      });
    }

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await settle(
        { admission, outcome: request.outcome, signal },
        tracedUpstreamCall(
          { provider, model: resolved.model, logger: request.log, principal: request.principal },
          () => provider.chat(upstreamRequest, { signal }),
        ),
        (r) => r.usage,
        (r) => estimateChatUsage(upstreamRequest, r.body),
      );
      return restoreChatResponse(result.body, masked.restore);
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  app.post("/v1/embeddings", { schema: docs.embeddings }, async (request, reply) => {
    const body = parseEmbeddingsRequest(request.body);
    const [resolved, provider] = route(body.model, request, reply);
    const inputEstimate = estimateEmbeddingTokens(body.input);
    const admission = await admit(request, reply, inputEstimate, {
      operation: "embeddings",
      stream: false,
      model: body.model,
      resolved,
    });
    const masked = await pii.embeddings({ request, reply, admission }, body);

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await settle(
        { admission, outcome: request.outcome, signal },
        tracedUpstreamCall(
          {
            provider,
            model: resolved.model,
            logger: request.log,
            operation: "embeddings",
            principal: request.principal,
          },
          () => provider.embeddings({ ...masked.body, model: resolved.model }, { signal }),
        ),
        (r) => r.usage && { inputTokens: r.usage.inputTokens, outputTokens: 0 },
        () => ({ inputTokens: inputEstimate, outputTokens: 0 }),
      );
      return result.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  // Anthropic Messages API (spec 014): same routing, admission and streaming steps.
  registerMessagesRoute(app, {
    config: opts.config,
    route,
    admit,
    settle,
    abortOnClientDisconnect,
  });
}

/**
 * Settles a non-streaming call. Reconciles the token reservation (spec 005, AC-6): real usage on
 * success (the reservation is kept when the provider reports none), a full refund on failure.
 * Ends the outcome tracker (spec 006): success with provider usage (else the estimate), a client
 * disconnect (499, nothing generated) or the error sent to the client.
 */
async function settle<T>(
  ctx: {
    admission: Admission | undefined;
    outcome: OutcomeTracker | undefined;
    signal: AbortSignal;
  },
  call: Promise<T>,
  reported: (result: T) => TokenUsage | undefined,
  estimate: (result: T) => TokenUsage,
): Promise<T> {
  const { admission, outcome } = ctx;
  try {
    const result = await call;
    const usage = reported(result);
    await admission?.reconcile(
      usage ? usage.inputTokens + usage.outputTokens : admission.reservedTokens,
    );
    outcome?.succeed(usage ? { usage } : { usage: estimate(result), estimated: true });
    return result;
  } catch (error) {
    await admission?.reconcile(undefined);
    if (ctx.signal.aborted) outcome?.clientClosed({ headersSent: false });
    else outcome?.fail(error);
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
