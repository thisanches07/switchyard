import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = resolve(import.meta.dirname, "../../fixtures/shutdown-server.ts");

// Windows has no POSIX signals: child.kill("SIGTERM") is a hard kill there. Runs in Linux CI.
describe.skipIf(process.platform === "win32")("shutdown (real process)", () => {
  it("exits within 10s on SIGTERM", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolveListening, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Server listening")) resolveListening();
      });
      child.once("exit", (code) => reject(new Error(`exited early with ${code}`)));
    });

    const started = performance.now();
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((r) => child.once("exit", r));

    expect(code).toBe(0);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 20_000);
});
