import type { FastifyInstance, FastifyReply } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { internalError, modelNotFound } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import { listModels } from "../routing/models.js";
import { type ResolvedModel, resolveModel } from "../routing/resolve.js";
import { parseChatRequest, parseEmbeddingsRequest } from "./schema.js";
import { streamChat } from "./stream.js";
import { tracedUpstreamCall } from "./telemetry.js";

export interface ProxyRoutesOptions {
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  /** Gateway start time in seconds, reported as `created` in /v1/models. */
  startedAt: number;
}

export async function proxyRoutes(app: FastifyInstance, opts: ProxyRoutesOptions): Promise<void> {
  /** Resolves the model, picks the provider and sets the provider/model headers. */
  function route(model: string, reply: FastifyReply): [ResolvedModel, ChatProvider] {
    const resolved = resolveModel(model, opts.config);
    if (!resolved) throw modelNotFound(model);
    const provider = opts.providers.get(resolved.provider);
    if (!provider) throw internalError();
    reply.header("x-switchyard-provider", resolved.provider);
    reply.header("x-switchyard-model", resolved.model);
    return [resolved, provider];
  }

  app.get("/v1/models", async () => listModels(opts.config, opts.startedAt));

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = parseChatRequest(request.body);
    const [resolved, provider] = route(body.model, reply);
    const upstreamRequest = { ...body, model: resolved.model };

    if (body.stream === true) {
      return streamChat({ reply, provider, request: upstreamRequest, logger: request.log });
    }

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await tracedUpstreamCall(
        { provider, model: resolved.model, logger: request.log },
        () => provider.chat(upstreamRequest, { signal }),
      );
      return result.body;
    } finally {
      reply.header("x-switchyard-upstream-ms", Math.round(performance.now() - started));
    }
  });

  app.post("/v1/embeddings", async (request, reply) => {
    const body = parseEmbeddingsRequest(request.body);
    const [resolved, provider] = route(body.model, reply);

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await tracedUpstreamCall(
        { provider, model: resolved.model, logger: request.log, operation: "embeddings" },
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
