// Migration 080 makes the records HAPI left behind inert, once, so no code
// has to recognize them: active runs stop without replay, their pending
// approvals are rejected, connections stay disconnected and stop presenting
// as subscriptions, and memory recall keeps HAPI conversations included.
// Nothing is deleted, and nothing that is not HAPI changes.
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETIREMENT = "080-retire-hapi-records.sql";

it("retires HAPI records without deleting or replaying anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-hapi-retirement-"));
  try {
    const db = new Database(join(dir, "loop.db"));
    db.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort())
      if (file < RETIREMENT)
        db.exec(readFileSync(join("migrations", file), "utf8"));

    const hapiMeta = JSON.stringify({
      backend: "hapi",
      runtimeKind: "hapi",
      authMode: "subscription",
      environmentId: "env",
    });
    const apiMeta = JSON.stringify({
      authMode: "subscription",
      runtimeHostId: "host",
    });
    const insertConnection = db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'codex','C','',?,'[]',?,1)",
    );
    insertConnection.run("hapi-conn", "owner", "connected", hapiMeta);
    insertConnection.run("direct-conn", "owner", "connected", apiMeta);
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at) VALUES('agent','owner','a','a','codex','hapi-conn','m','',1)",
    ).run();
    const insertConversation = db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,execution_backend,created_at) VALUES(?,'owner','agent','T',?,1)",
    );
    insertConversation.run("hapi-a", "hapi");
    insertConversation.run("hapi-b", "hapi");
    insertConversation.run("direct", "legacy");
    // An explicit choice to exclude one HAPI conversation stays as it is.
    db.prepare(
      "INSERT INTO memory_policy(owner_id,scope,enabled) VALUES('owner','conversation:hapi-b',0)",
    ).run();
    const insertRun = db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,worker_id,heartbeat,active_since,created_at,updated_at) VALUES(?,'owner','agent',?,'agent','Old work',?,?,?,?,?,?,1,1)",
    );
    const hapiPayload = JSON.stringify({ execution: { backend: "hapi" } });
    insertRun.run(
      "queued",
      "hapi-a",
      "queued",
      "k1",
      hapiPayload,
      null,
      null,
      null,
    );
    insertRun.run(
      "dispatched",
      "hapi-a",
      "awaiting_approval",
      "k2",
      "{}",
      "gone",
      5,
      2,
    );
    insertRun.run(
      "finished",
      "hapi-a",
      "completed",
      "k3",
      hapiPayload,
      null,
      null,
      null,
    );
    insertRun.run(
      "direct-run",
      "direct",
      "running",
      "k4",
      "{}",
      "worker",
      5,
      2,
    );
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO native_dispatches(run_id,conversation_id,local_id,payload_hash,envelope,billing,environment_id,generation,state,created_at,updated_at) VALUES('dispatched','hapi-a','l','h','{}','{}','env',1,'accepted',1,1)",
    ).run();
    db.pragma("foreign_keys = ON");
    const insertApproval = db.prepare(
      "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,'owner',?,?,'{}','pending',1,9999999999999)",
    );
    insertApproval.run("hapi-approval", "dispatched", "d1");
    insertApproval.run("direct-approval", "direct-run", "d2");
    const counts = () =>
      [
        "connections",
        "conversations",
        "runs",
        "approvals",
        "native_dispatches",
      ].map(
        (t) =>
          (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n,
      );
    const before = counts();

    db.exec(readFileSync(join("migrations", RETIREMENT), "utf8"));

    expect(counts()).toEqual(before);
    const run = (id: string) =>
      db
        .prepare(
          "SELECT state,worker_id,error,active_since FROM runs WHERE id=?",
        )
        .get(id) as any;
    for (const id of ["queued", "dispatched"]) {
      expect(run(id)).toMatchObject({
        state: "interrupted",
        worker_id: null,
        active_since: null,
      });
      expect(run(id).error).toMatch(/not replayed/);
    }
    expect(run("finished").state).toBe("completed");
    expect(run("direct-run")).toMatchObject({
      state: "running",
      worker_id: "worker",
      error: null,
    });
    const approval = (id: string) =>
      (db.prepare("SELECT state FROM approvals WHERE id=?").get(id) as any)
        .state;
    expect(approval("hapi-approval")).toBe("rejected");
    expect(approval("direct-approval")).toBe("pending");
    const connection = (id: string) =>
      db
        .prepare("SELECT status,metadata FROM connections WHERE id=?")
        .get(id) as any;
    expect(connection("hapi-conn").status).toBe("disconnected");
    expect(JSON.parse(connection("hapi-conn").metadata)).toEqual({
      backend: "hapi",
      runtimeKind: "hapi",
      environmentId: "env",
    });
    expect(connection("direct-conn")).toEqual({
      status: "connected",
      metadata: apiMeta,
    });
    expect(
      db
        .prepare("SELECT scope,enabled FROM memory_policy ORDER BY scope")
        .all(),
    ).toEqual([
      { scope: "conversation:hapi-a", enabled: 1 },
      { scope: "conversation:hapi-b", enabled: 0 },
    ]);
    expect(
      db.prepare("SELECT max(version) v FROM schema_version").get(),
    ).toEqual({ v: 80 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
