// Preloaded by the usage worker (spec 006): same telemetry as the gateway, own service name.
process.env.OTEL_SERVICE_NAME ??= "switchyard-usage-worker";
await import("./register.js");
