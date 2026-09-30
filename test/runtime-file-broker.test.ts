import { afterAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const workspace = mkdtempSync(join(tmpdir(), "loop-broker-file-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

it("reads a Codex workspace file through the broker without starting the Codex worker", async () => {
  writeFileSync(join(workspace, "result.txt"), "published from Codex");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const token = "broker-file-test-token-at-least-32-characters";
  const broker = spawn(process.execPath, ["runtime/broker.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOOP_RUNTIME_MODE: "host",
      LOOP_RUNTIME_WORKDIR: workspace,
      LOOP_RUNTIME_TOKEN: token,
      PORT: String(port),
    },
    stdio: "ignore",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      ready = await fetch(url + "/health", {
        headers: { authorization: `Bearer ${token}` },
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready).toBe(true);
    const response = await fetch(url + "/runtime", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "a".repeat(64),
        provider: "codex",
        action: "read-file",
        path: "result.txt",
        offset: 0,
      }),
    });
    expect(response.status).toBe(200);
    const chunk = await response.json();
    expect(Buffer.from(chunk.base64, "base64").toString()).toBe(
      "published from Codex",
    );
  } finally {
    broker.kill("SIGTERM");
    await new Promise<void>((resolve) => broker.once("close", () => resolve()));
  }
});
