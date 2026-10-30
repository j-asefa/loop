import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { compiledServerFixture } from "./helpers/compiled-server";
import { WorkspaceFrameV3 } from "../src/shared/workspace-events";

it("processes overdue durable rows after a full server restart and preserves the owner epoch", async () => {
  const compiled = await compiledServerFixture();
  const dir = mkdtempSync(join(tmpdir(), "loop55-expiry-restart-"));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("LOOP55_")),
    ),
    LOOP55_PROFILE: "server",
    LOOP55_AUTH_MODE: "single-user",
    LOOP55_DATA_DIR: dir,
    LOOP55_URL: "http://127.0.0.1",
    PORT: "0",
    LOOP55_TEST_CARDS_SOURCE: compiled.source,
    NODE_ENV: "test",
    LOOP55_LISTEN_HOST: "127.0.0.1",
    LOOP55_BIND_ADDRESS: "127.0.0.1",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    LOOP55_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  let child: ReturnType<typeof spawn> | undefined;
  let db: Database.Database | undefined;
  let socket: WebSocket | undefined;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  }
  async function start() {
    child = spawn(
      process.execPath,
      ["--import", "tsx", "test/fixtures/cards-server.ts"],
      { env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let errors = "";
    child.stderr?.on("data", (part) => {
      errors += part;
    });
    return await Promise.race([
      once(child, "message").then(
        ([message]) => message as { owner: string; origin: string },
      ),
      once(child, "exit").then(() => {
        throw Error(errors || "Fixture exited before ready");
      }),
    ]);
  }
  try {
    const first = await start();
    db = new Database(join(dir, "loop55.db"));
    db.pragma("foreign_keys=ON");
    db.prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES('run',?,'Prompt','awaiting_approval','key',1,1)",
    ).run(first.owner);
    const expires = Date.now() + 1200;
    db.prepare(
      "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('approval',?,'run','digest','{}','pending',1,?)",
    ).run(first.owner, expires);
    await expect
      .poll(() =>
        db!
          .prepare(
            "SELECT next_deadline FROM change_deadlines WHERE owner_id=?",
          )
          .get(first.owner),
      )
      .toEqual({ next_deadline: expires });
    const before = db
      .prepare("SELECT * FROM change_watermark WHERE owner_id=?")
      .get(first.owner) as any;
    await stop();
    await expect.poll(() => Date.now() > expires, { timeout: 2000 }).toBe(true);
    // A second obligation created while down has never had a process timer.
    db.prepare(
      "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('already-overdue',?,'run','overdue','{}','pending',1,?)",
    ).run(first.owner, expires - 1000);
    const restarted = await start();
    expect(restarted.owner).toBe(first.owner);
    await expect
      .poll(() =>
        db!
          .prepare("SELECT processed FROM change_expiries ORDER BY subject_id")
          .all(),
      )
      .toEqual([{ processed: 1 }, { processed: 1 }]);
    const watermark = db
      .prepare("SELECT * FROM change_watermark WHERE owner_id=?")
      .get(first.owner) as any;
    expect(watermark.epoch).toBe(before.epoch);
    expect(watermark.last_event_id).toBeGreaterThan(before.last_event_id);
    socket = new WebSocket(
      restarted.origin.replace("http:", "ws:") + "/api/events/ws?v=3&clock=1",
      { headers: { origin: restarted.origin } },
    );
    const frame = WorkspaceFrameV3.parse(
      JSON.parse(String((await once(socket, "message"))[0])),
    );
    expect(frame).toMatchObject({
      type: "reset",
      epoch: before.epoch,
      nextDeadline: null,
    });
    expect(
      db
        .prepare("SELECT state,expires_at FROM approvals WHERE id='approval'")
        .get(),
    ).toEqual({ state: "pending", expires_at: expires });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    socket?.terminate();
    await stop();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
    await compiled.close();
  }
}, 20_000);
