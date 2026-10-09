process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = await mkdtemp(join(tmpdir(), "loop-fallback-"));
process.env.LOOP_DATA_DIR = dir;
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");
test("managed startup failure retains the paired workspace even without the neutral flag", async () => {
  const options = {
    harness: "codex" as const,
    executable: "codex",
    project: dir,
    version: "workspace",
    billing: "existing" as const,
  };
  const host = new WorkspaceHost(dir, options);
  let cookie = "";
  let attempts = 0;
  let pairedBeforeStartup = false;
  let cleaned = false;
  const notices: string[] = [];
  const { prepareManagedRuntime } = await import("../src/managed-start.js");
  try {
    const account = await host.start(
      options,
      undefined,
      async () => {
        assert.equal(pairedBeforeStartup, true);
        attempts++;
        return prepareManagedRuntime(
          {
            async prepare() {
              assert.equal(pairedBeforeStartup, true);
              const runtimes = (await fetch(
                host.origin + "/api/workspace/runtimes",
                {
                  headers: { cookie },
                },
              ).then((r) => r.json())) as any;
              assert.equal(runtimes.setup, "preparing");
              throw new Error("private configuration must not escape");
            },
            async start() {
              throw new Error("must not start after prepare failure");
            },
            async close() {
              cleaned = true;
            },
          },
          () => false,
          (message) => notices.push(message),
        );
      },
      false,
      async () => {
        assert.equal(attempts, 0);
        const secret = new URL(host.pair().url).hash.slice(6);
        const response = await fetch(host.origin + "/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: host.origin },
          body: JSON.stringify({
            secret,
            name: "fallback fixture",
            credential: "cookie",
          }),
        });
        assert.equal(response.status, 200);
        cookie = response.headers.get("set-cookie")!.split(";")[0];
        const workspace = (await fetch(host.origin + "/api/workspace", {
          headers: { cookie },
        }).then((r) => r.json())) as any;
        assert.deepEqual(workspace.harnesses, []);
        assert(workspace.projectPaths.length > 0);
        pairedBeforeStartup = true;
      },
    );
    assert.equal(attempts, 1);
    assert.equal(cleaned, true);
    const runtimes = (await fetch(host.origin + "/api/workspace/runtimes", {
      headers: { cookie },
    }).then((r) => r.json())) as any;
    assert.equal(runtimes.setup, "failed");
    assert(!JSON.stringify(runtimes).includes("private configuration"));
    assert.equal(
      notices.filter((message) => message.includes("failed")).length,
      1,
    );
    assert(!notices.join(" ").includes("private configuration"));
    assert.match(account.billing.description, /requires a working HAPI runner/);
    assert.deepEqual((await fetch(host.origin + "/api/workspace", {
      headers: { cookie },
    }).then((r) => r.json()) as any).harnesses, []);
  } finally {
    await host.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
