import type { FastifyInstance, FastifyReply } from "fastify";
import type { LoadedConfig } from "../../config/load.js";
import { internalError, modelNotFound, streamNotSupported } from "../../core/errors.js";
import type { ChatProvider } from "../../core/provider.js";
import { listModels } from "../routing/models.js";
import { resolveModel } from "../routing/resolve.js";
import { parseChatRequest } from "./schema.js";
import { tracedUpstreamCall } from "./telemetry.js";

export interface ProxyRoutesOptions {
  config: LoadedConfig;
  providers: ReadonlyMap<string, ChatProvider>;
  /** Gateway start time in seconds, reported as `created` in /v1/models. */
  startedAt: number;
}

export async function proxyRoutes(app: FastifyInstance, opts: ProxyRoutesOptions): Promise<void> {
  app.get("/v1/models", async () => listModels(opts.config, opts.startedAt));

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = parseChatRequest(request.body);
    if (body.stream === true) throw streamNotSupported();

    const resolved = resolveModel(body.model, opts.config);
    if (!resolved) throw modelNotFound(body.model);

    const provider = opts.providers.get(resolved.provider);
    if (!provider) throw internalError();
    reply.header("x-switchyard-provider", resolved.provider);
    reply.header("x-switchyard-model", resolved.model);

    const signal = abortOnClientDisconnect(reply);
    const started = performance.now();
    try {
      const result = await tracedUpstreamCall(
        { provider, model: resolved.model, logger: request.log },
        () => provider.chat({ ...body, model: resolved.model }, { signal }),
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
