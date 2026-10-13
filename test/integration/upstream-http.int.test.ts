import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpstreamNetworkError, UpstreamTimeoutError } from "../../src/core/provider.js";
import { createUndiciClient } from "../../src/infra/http/undici-client.js";

describe("undici HTTP client", () => {
  let server: Server;
  let base: string;
  const received: { body: unknown; headers: Record<string, unknown> }[] = [];
  const client = createUndiciClient({ connectMs: 500, ttfbMs: 300, totalMs: 1_000 });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString();
      });
      req.on("end", () => {
        received.push({ body: raw ? JSON.parse(raw) : undefined, headers: req.headers });
        if (req.url === "/ok") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.url === "/fail") {
          res.writeHead(500);
          res.end("boom");
        } else if (req.url === "/slow-headers") {
          setTimeout(() => res.end("late"), 2_000).unref();
        } else if (req.url === "/slow-body") {
          res.writeHead(200);
          res.write("{");
          setTimeout(() => res.end("}"), 2_000).unref();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await client.close();
  });

  const call = (path: string, signal = new AbortController().signal) =>
    client.postJson(
      `${base}${path}`,
      { hello: "world" },
      {
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        signal,
      },
    );

  it("posts JSON and returns status and text", async () => {
    const res = await call("/ok");
    expect(res).toEqual({ status: 200, text: '{"ok":true}' });
    expect(received.at(-1)?.body).toEqual({ hello: "world" });
    expect(received.at(-1)?.headers.authorization).toBe("Bearer k");
  });

  it("returns non-2xx statuses instead of throwing", async () => {
    expect(await call("/fail")).toEqual({ status: 500, text: "boom" });
  });

  it("headers timeout → UpstreamTimeoutError", async () => {
    await expect(call("/slow-headers")).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("total timeout while streaming the body → UpstreamTimeoutError", async () => {
    await expect(call("/slow-body")).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("connection refused → UpstreamNetworkError", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await expect(
      client.postJson(
        `http://127.0.0.1:${port}/x`,
        {},
        {
          headers: {},
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(UpstreamNetworkError);
  });

  it("caller abort is not reported as an upstream timeout or network error", async () => {
    const controller = new AbortController();
    const pending = call("/slow-headers", controller.signal);
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UpstreamTimeoutError);
    expect(error).not.toBeInstanceOf(UpstreamNetworkError);
  });
});
