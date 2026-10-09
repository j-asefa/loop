process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { until } from "./helpers.js";
const dir = await realpath(await mkdtemp(join(tmpdir(), "loop-workspace-")));
process.env.LOOP_DATA_DIR = dir;
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db, emit } = await import("../src/server/db.js");

test("paired workspace preserves projects, history and event replay without any direct harness entry point", async () => {
  const options = {
    harness: "codex" as const,
    executable: resolve("test/harness.mjs"),
    project: dir,
    version: "fixture",
    billing: "existing" as const,
  };
  const host = new WorkspaceHost(dir, options);
  let socket: WebSocket | undefined;
  try {
    await host.start(options);
    assert.equal((await fetch(host.origin + "/api/bootstrap")).status, 401);
    const secret = new URL(host.pair().url).hash.slice(6);
    const paired = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ secret, name: "fixture" }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await fetch(host.origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json());
    const request = (
      path: string,
      body?: object,
      method = body ? "POST" : "GET",
    ) =>
      fetch(host.origin + "/api" + path, {
        method,
        headers: {
          cookie,
          Origin: host.origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const workspace = await request("/workspace").then((r) => r.json());
    assert.deepEqual(workspace.harnesses, []);
    assert.equal(workspace.projectPaths[0].path, dir);
    assert.deepEqual(
      (await request("/workspace/runtimes").then((r) => r.json())).runtimes,
      [],
    );
    for (const flavor of ["codex", "claude", "pi", "opencode"]) {
      const enabled = await request(`/workspace/runtimes/${flavor}/enable`, {
        projectId: workspace.projectPaths[0].folder_id,
        billing: flavor === "pi" ? "existing" : "subscription",
      });
      assert.equal(enabled.status, 409);
      assert.match((await enabled.json()).error, /HAPI/);
      for (const suffix of [
        "auth",
        "auth/start",
        "auth/answer",
        "auth/cancel",
        "upgrade",
        "upgrade/recover",
      ])
        assert.equal(
          (
            await request(`/workspace/runtimes/${flavor}/${suffix}`, {
              commandId: randomUUID(),
            })
          ).status,
          404,
        );
    }
    const foreign = await request("/workspace/runtimes/codex/enable", {
      projectId: "foreign",
      billing: "subscription",
    });
    assert.equal(foreign.status, 404);
    const cid = randomUUID(),
      conversation = randomUUID();
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'local-workspace','codex','Archived','','disconnected','[]','{\"loopHarness\":\"codex\"}',0)",
    ).run(cid);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'local-workspace','Archived',0)",
    ).run(conversation);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,'local-workspace',?,'assistant','Saved reply',0)",
    ).run(randomUUID(), conversation);
    assert(
      (
        await request(`/conversations/${conversation}`).then((r) => r.json())
      ).messages.some((m: any) => m.content === "Saved reply"),
    );
    assert.equal((await request(`/connections/${cid}/models`)).status, 409);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM harnesses").get() as any).n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT count(*) n FROM native_dispatch").get() as any).n,
      0,
    );
    // A real paired socket still receives durable workspace events.
    const events: any[] = [];
    socket = new WebSocket(
      host.origin.replace("http:", "ws:") + "/ws?cursor=0",
      { headers: { Cookie: cookie, Origin: host.origin } },
    );
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    const { enqueue } = await import("../src/server/queue.js");
    const eventRun = enqueue("local-workspace", "Archived", randomUUID(), {
      conversation,
    });
    db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(eventRun.id);
    emit("local-workspace", eventRun.id, "fixture.hapi", { ready: true });
    await until(() => JSON.stringify(events).includes("fixture.hapi"));
  } finally {
    socket?.terminate();
    await host.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
