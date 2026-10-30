import { afterAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const workspace = mkdtempSync(join(tmpdir(), "loop55-broker-file-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

it("reads a Codex workspace file through the broker, and says why it refuses one", async () => {
  writeFileSync(join(workspace, "result.txt"), "published from Codex");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const token = "broker-file-test-token-at-least-32-characters";
  const broker = spawn(process.execPath, ["runtime/broker.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOOP55_RUNTIME_MODE: "host",
      LOOP55_RUNTIME_WORKDIR: workspace,
      LOOP55_RUNTIME_TOKEN: token,
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
    // A refused file names its reason instead of a generic outage, so the
    // agent can fix it rather than retry.
    writeFileSync(join(workspace, "review.mp4"), "");
    truncateSync(join(workspace, "review.mp4"), 49 * 1024 * 1024);
    const refuse = async (path: string) => {
      const refused = await fetch(url + "/runtime", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          key: "a".repeat(64),
          provider: "codex",
          action: "read-file",
          path,
          offset: 0,
        }),
      });
      expect(refused.status).toBe(422);
      return refused.json();
    };
    expect(await refuse("review.mp4")).toEqual({
      code: "file_rejected",
      error:
        "This file is 49.0 MB; Loop55 publishes files up to 25 MB. Make it smaller, for example by compressing or splitting it, then publish again.",
    });
    expect(await refuse("renders/missing.mp4")).toEqual({
      code: "file_rejected",
      error: "No file at renders/missing.mp4 in the workspace",
    });
  } finally {
    broker.kill("SIGTERM");
    await new Promise<void>((resolve) => broker.once("close", () => resolve()));
  }
});
