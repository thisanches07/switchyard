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
          res.writeHead(200, { "content-type": "application/json", "request-id": "req_up_1" });
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
        } else if (req.url === "/stream") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          let n = 0;
          const tick = setInterval(() => {
            n += 1;
            res.write(`data: ${n}\n\n`);
            if (n === 4) {
              clearInterval(tick);
              res.end();
            }
          }, 150);
          res.on("close", () => clearInterval(tick));
        } else if (req.url === "/stream-stall") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: 1\n\n");
        } else if (req.url === "/stream-long") {
          // Keeps sending for longer than totalMs (1 s) with short gaps.
          res.writeHead(200, { "content-type": "text/event-stream" });
          const tick = setInterval(() => res.write("data: x\n\n"), 100);
          setTimeout(() => {
            clearInterval(tick);
            res.end();
          }, 1_600).unref();
          res.on("close", () => clearInterval(tick));
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
    expect(res).toMatchObject({ status: 200, text: '{"ok":true}' });
    // Spec 014: response headers are exposed (lower-cased) for request ids and retry-after.
    expect(res.headers?.["request-id"]).toBe("req_up_1");
    expect(received.at(-1)?.body).toEqual({ hello: "world" });
    expect(received.at(-1)?.headers.authorization).toBe("Bearer k");
  });

  it("returns non-2xx statuses instead of throwing", async () => {
    expect(await call("/fail")).toMatchObject({ status: 500, text: "boom" });
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

  it("reads ttfb and total timeouts per request, so reloaded values apply (spec 008)", async () => {
    const timeouts = { connectMs: 500, ttfbMs: 300, totalMs: 1_000 };
    const reloadable = createUndiciClient(() => timeouts);
    const slow = () =>
      reloadable.postJson(
        `${base}/slow-headers`,
        {},
        {
          headers: {},
          signal: new AbortController().signal,
        },
      );
    try {
      await expect(slow()).rejects.toBeInstanceOf(UpstreamTimeoutError);
      timeouts.ttfbMs = 10_000;
      timeouts.totalMs = 10_000;
      expect(await slow()).toMatchObject({ status: 200, text: "late" });
    } finally {
      await reloadable.close();
    }
  });

  describe("postStream", () => {
    const open = (path: string, signal = new AbortController().signal) =>
      client.postStream(`${base}${path}`, { stream: true }, { headers: {}, signal });

    async function readAll(body: AsyncIterable<Uint8Array>) {
      const times: number[] = [];
      let text = "";
      const started = performance.now();
      for await (const bytes of body) {
        times.push(performance.now() - started);
        text += new TextDecoder().decode(bytes);
      }
      return { times, text };
    }

    it("yields bytes as the server sends them", async () => {
      const res = await open("/stream");
      expect(res.status).toBe(200);
      const { times, text } = await readAll(res.body);
      expect(text).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n");
      expect(times.length).toBeGreaterThanOrEqual(2);
      expect(times[0]).toBeLessThan((times.at(-1) ?? 0) - 200);
    });

    it("returns non-2xx bodies as text", async () => {
      const res = await open("/fail");
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("boom");
    });

    it("idle timeout between chunks → UpstreamTimeoutError", async () => {
      const res = await open("/stream-stall");
      await expect(readAll(res.body)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    });

    it("a stream may outlive totalMs once data is flowing", async () => {
      const res = await open("/stream-long");
      const { text } = await readAll(res.body);
      expect(text.length).toBeGreaterThan(0);
    });

    it("headers timeout before the stream opens → UpstreamTimeoutError", async () => {
      await expect(open("/slow-headers")).rejects.toBeInstanceOf(UpstreamTimeoutError);
    });

    it("caller abort stops the body without an upstream error", async () => {
      const controller = new AbortController();
      const res = await open("/stream", controller.signal);
      const iterator = res.body[Symbol.asyncIterator]();
      await iterator.next();
      controller.abort();
      const error = await (async () => {
        try {
          while (!(await iterator.next()).done) {}
        } catch (e) {
          return e;
        }
      })();
      expect(error).not.toBeInstanceOf(UpstreamTimeoutError);
      expect(error).not.toBeInstanceOf(UpstreamNetworkError);
    });
  });
});
