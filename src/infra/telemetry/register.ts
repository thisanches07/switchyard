// Preloaded with `node --import` so instrumentations patch modules before the app loads them.
import { register } from "node:module";
import { startTelemetry } from "./sdk.js";

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
startTelemetry(process.env);
