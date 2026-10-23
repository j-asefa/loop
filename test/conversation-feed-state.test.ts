// The Feed reads each conversation's state from columns that triggers keep
// current (migrations 081 and 084). These tests compare those columns, after every
// kind of write, with the state the Feed used to derive on each request.
import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function database(through = Infinity) {
  const dir = mkdtempSync(join(tmpdir(), "loop-feed-state-"));
  dirs.push(dir);
  const db = new Database(join(dir, "loop.db"));
  db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    if (Number(file.split("-")[0]) <= through)
      db.exec(readFileSync(join("migrations", file), "utf8"));
  return db;
}

// Reference derivation, including delegated and workflow work.
const current = `FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY CASE WHEN r.state IN ('running','pausing','paused','awaiting_approval') THEN 0 ELSE 1 END,r.created_at DESC,r.rowid DESC LIMIT 1`;
const reference = `SELECT
  (SELECT r.id ${current}) feed_run_id,
  (SELECT r.state ${current}) feed_run_raw_state,
  (SELECT CASE WHEN r.state IN ('running','pausing') AND r.worker_id IS NULL THEN 'waiting_children' ELSE r.state END ${current}) feed_run_state,
  (SELECT r.attention_dismissed_at ${current}) feed_run_dismissed_at,
  (SELECT count(*) FROM runs q WHERE q.owner_id=c.owner_id AND q.conversation_id=c.id AND q.state='queued') feed_queued,
  (SELECT r.id FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed' ORDER BY r.updated_at DESC,r.rowid DESC LIMIT 1) feed_done_run_id,
  (SELECT max(r.updated_at) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed') feed_done_at,
  max(c.created_at,
    COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id),0),
    COALESCE((SELECT max(r.updated_at) FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id),0)) feed_last_activity_at,
  (SELECT m.id FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) feed_last_message_id,
  COALESCE(c.project_id,(SELECT json_extract(fr.payload,'$.folderId') FROM runs fr WHERE fr.owner_id=c.owner_id AND fr.conversation_id=c.id ORDER BY fr.created_at DESC,fr.rowid DESC LIMIT 1)) feed_folder_id,
  (EXISTS(SELECT 1 FROM messages m WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id) OR EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id)) feed_visible,
  (SELECT max(a.expires_at) FROM approvals a JOIN runs ar ON ar.id=a.run_id AND ar.owner_id=a.owner_id WHERE a.owner_id=c.owner_id AND ar.conversation_id=c.id AND a.state='pending') feed_approval_until
FROM conversations c WHERE c.id=?`;
const stored = `SELECT feed_run_id,feed_run_raw_state,feed_run_state,feed_run_dismissed_at,feed_queued,feed_done_run_id,feed_done_at,feed_last_activity_at,feed_last_message_id,feed_folder_id,feed_visible,feed_approval_until FROM conversations WHERE id=?`;

it("closes obsolete approval requests on upgrade and terminal transitions without changing uncertain receipts", () => {
  const db = database(102);
  const w = writer(db);
  w.conversation("stopped");
  w.conversation("active");
  w.run("old", "stopped", "interrupted");
  w.run("live", "active", "awaiting_approval");
  const insert = db.prepare("INSERT INTO approvals(id,owner_id,run_id,digest,request,state,result,created_at,expires_at) VALUES(?,'o',?,?,'{}',?,NULL,1,99999)");
  for (const state of ["pending", "approved", "executing", "completed", "unknown"])
    insert.run(state, "old", state, state);
  insert.run("live", "live", "live", "pending");
  db.exec(readFileSync("migrations/103-terminal-run-approvals.sql", "utf8"));
  expect(db.prepare("SELECT id,state FROM approvals ORDER BY id").all()).toEqual([
    { id: "approved", state: "approved" }, { id: "completed", state: "completed" },
    { id: "executing", state: "executing" }, { id: "live", state: "pending" },
    { id: "pending", state: "rejected" }, { id: "unknown", state: "unknown" },
  ]);
  expect(db.prepare("SELECT feed_approval_until FROM conversations WHERE id='stopped'").get()).toEqual({ feed_approval_until: null });
  expectState(db, ["stopped", "active"], "upgrade");
  db.prepare("UPDATE runs SET state='interrupted' WHERE id='live'").run();
  expect(db.prepare("SELECT state FROM approvals WHERE id='live'").get()).toEqual({ state: "rejected" });
  expect(db.prepare("SELECT feed_run_state,feed_approval_until FROM conversations WHERE id='active'").get()).toEqual({ feed_run_state: "interrupted", feed_approval_until: null });
  expectState(db, ["stopped", "active"], "recovery");
  db.close();
}, 15_000);

function writer(db: Database.Database) {
  let clock = 1000;
  return {
    tick: () => (clock += 10),
    conversation(id: string, owner = "o") {
      db.prepare("INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'T',?)").run(id, owner, (clock += 10));
    },
    run(id: string, conversation: string | null, state: string, extra: { worker?: string; folder?: string; created?: number } = {}) {
      const time = extra.created ?? (clock += 10);
      db.prepare(
        "INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,payload,worker_id,created_at,updated_at) VALUES(?,?,?,'agent','p',?,?,?,?,?,?)",
      ).run(id, "o", conversation, state, "k" + id, JSON.stringify(extra.folder ? { folderId: extra.folder } : {}), extra.worker ?? null, time, time);
    },
    message(id: string, conversation: string, created?: number) {
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,'user','m','{}',?)",
      ).run(id, "o", conversation, created ?? (clock += 10));
    },
  };
}

function expectState(db: Database.Database, ids: string[], step: string) {
  for (const id of ids)
    expect({ step, id, ...(db.prepare(stored).get(id) as object) }).toEqual({
      step,
      id,
      ...(db.prepare(reference).get(id) as object),
    });
}

it("keeps every conversation's Feed state equal to the per-request derivation after each kind of write", () => {
  const db = database();
  const w = writer(db);
  const ids = ["a", "b"];
  const steps: [string, () => void][] = [
    ["new conversations", () => { w.conversation("a"); w.conversation("b"); }],
    ["a message makes a thread visible", () => w.message("m1", "a")],
    ["an earlier-dated message is not the latest", () => w.message("m0", "a", 500)],
    ["a same-time message is the latest by insertion", () => w.message("m2", "a", 1040)],
    ["a queued run", () => w.run("r1", "a", "queued", { folder: "f1" })],
    ["a second queued run", () => w.run("r2", "a", "queued")],
    ["claimed", () => db.prepare("UPDATE runs SET state='running',worker_id='w',updated_at=? WHERE id='r1'").run(w.tick())],
    ["waiting on children", () => db.prepare("UPDATE runs SET worker_id=NULL WHERE id='r1'").run()],
    ["an approval", () => db.prepare("INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('ap','o','r1','d','{}','pending',1,99999)").run()],
    ["approval expires later", () => db.prepare("UPDATE approvals SET expires_at=123456 WHERE id='ap'").run()],
    ["approval decided", () => db.prepare("UPDATE approvals SET state='approved' WHERE id='ap'").run()],
    ["completed", () => db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id='r1'").run(w.tick())],
    ["next run fails", () => db.prepare("UPDATE runs SET state='failed',updated_at=? WHERE id='r2'").run(w.tick())],
    ["failure dismissed", () => db.prepare("UPDATE runs SET attention_dismissed_at=1 WHERE id='r2'").run()],
    ["a run becomes a delegate", () => {
      w.run("parent", "b", "running", { worker: "w" });
      db.prepare("INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES('parent','c','r1','{}',0)").run();
    }],
    ["the delegation is removed", () => db.prepare("DELETE FROM delegations WHERE child_run_id='r1'").run()],
    ["a workflow step adopts a run", () => {
      w.run("wf", null, "running");
      db.prepare("INSERT INTO workflow_steps(run_id,step_id,position,state,child_run_id) VALUES('wf','s',0,'running',NULL)").run();
      db.prepare("UPDATE workflow_steps SET child_run_id='r2' WHERE run_id='wf'").run();
    }],
    ["a project is recorded", () => {
      db.prepare("INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES('p','o',NULL,'project','P',1)").run();
      db.prepare("UPDATE conversations SET project_id='p' WHERE id='a'").run();
    }],
    ["a message moves between threads", () => db.prepare("UPDATE messages SET conversation_id='b' WHERE id='m2'").run()],
    ["a message is re-dated", () => db.prepare("UPDATE messages SET created_at=5000 WHERE id='m1'").run()],
    ["a message is deleted", () => db.prepare("DELETE FROM messages WHERE id='m1'").run()],
    ["a run moves between threads", () => db.prepare("UPDATE runs SET conversation_id='b' WHERE id='r2'").run()],
    ["a run is deleted", () => {
      db.prepare("DELETE FROM workflow_steps WHERE child_run_id='r2'").run();
      db.prepare("DELETE FROM runs WHERE id='r2'").run();
    }],
    ["an older-dated run is not the newest", () => w.run("r0", "a", "completed", { created: 1 })],
  ];
  for (const [name, write] of steps) {
    write();
    expectState(db, ids, name);
  }
}, 15_000);

it("backfills existing conversations from their history", () => {
  const db = database(80);
  const w = writer(db);
  w.conversation("a");
  w.conversation("b");
  w.conversation("empty");
  w.message("m1", "a");
  w.run("r1", "a", "completed", { folder: "f" });
  w.run("r2", "a", "awaiting_approval", { worker: "w" });
  db.prepare("INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES('ap','o','r2','d','{}','pending',1,9)").run();
  w.run("r3", "b", "completed");
  w.run("p", null, "running");
  db.prepare("INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES('p','c','r3','{}',0)").run();
  db.exec(readFileSync(join("migrations", "081-conversation-feed-state.sql"), "utf8"));
  db.exec(readFileSync(join("migrations", "084-visible-agent-work.sql"), "utf8"));
  expectState(db, ["a", "b", "empty"], "backfill");
  expect(db.prepare("SELECT feed_visible FROM conversations WHERE id IN ('b','empty') ORDER BY id").all()).toEqual([
    { feed_visible: 1 },
    { feed_visible: 0 },
  ]);
});
