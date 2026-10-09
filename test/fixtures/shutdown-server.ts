// Spawned by shutdown.process.test.ts: a real HTTP server wired to installShutdown.
import Fastify from "fastify";
import { createLogger } from "../../src/infra/logger.js";
import { installShutdown } from "../../src/lifecycle/shutdown.js";

const logger = createLogger({ level: "info" });
const app = Fastify({ loggerInstance: logger });
app.get("/", async () => "ok");
await app.listen({ port: 0, host: "127.0.0.1" });
installShutdown({ app, closers: [], timeoutMs: 9_000, logger });
