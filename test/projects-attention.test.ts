import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import { belongsToProject } from "../src/shared/projects";

const dir = mkdtempSync(join(tmpdir(), "loop-project-attention-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { submit } = await import("../src/server/agent-runtime");
const { listRuns } = await import("../src/server/run-attention");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.get("/runs", (req, res) =>
  res.json(listRuns(res.locals.owner, [], req.query.active === "1")),
);
app.use(core, workspace);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = "http://127.0.0.1:" + (server.address() as any).port;
async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  owner = "alice",
) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
const connection = id();
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice','openai','Fixture','','connected',?,?)",
).run(connection, JSON.stringify([{ id: "fixture" }]), now());
async function project(owner = "alice") {
  return (
    await api(
      "/folders",
      { name: "Project " + id(), kind: "project" },
      "POST",
      owner,
    )
  ).data;
}
async function agent(folderId?: string) {
  return (
    await api("/agents", {
      name: "scout-" + id().slice(0, 8),
      connectionId: connection,
      model: "fixture",
      folderId,
    })
  ).data;
}
const record = (run: string) =>
  db.prepare("SELECT * FROM runs WHERE id=?").get(run) as any;
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("persists project membership without an initial prompt and atomically enforces ownership on reassignment", async () => {
  const p = await project(),
    a = await agent(p.id),
    other = await project("bob");
  expect(a.folder_id).toBe(p.id);
  expect(
    (await api("/bootstrap")).data.agents.find((x: any) => x.id === a.id)
      .folder_id,
  ).toBe(p.id);
  const bad = await api(
    "/agents/" + a.id,
    { name: "must-not-rename", folderId: other.id },
    "PATCH",
  );
  expect(bad.status).toBe(404);
  expect((await api("/agents/" + a.id)).data.agent.name).toBe(a.name);
  expect(
    (await api("/agents/" + a.id, { folderId: p.id }, "PATCH", "bob")).status,
  ).toBe(404);
  expect(
    (await api("/agents/" + a.id, { folderId: null }, "PATCH")).data.folder_id,
  ).toBeNull();
});
it("reuses an agent receipt created with the pre-membership field order", async () => {
  const p = await project();
  const data = {
    name: "legacy-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
    instructions: "",
    initialPrompt: "",
    folderId: p.id,
  };
  const key = id(),
    a = await api("/agents", { ...data, idempotencyKey: key });
  const oldHash = createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
  db.prepare(
    "UPDATE agent_creations SET request_hash=? WHERE owner_id='alice' AND request_key=?",
  ).run(oldHash, key);
  const retry = await api("/agents", { ...data, idempotencyKey: key });
  expect(retry.status).toBe(201);
  expect(retry.data.id).toBe(a.data.id);
});
it("uses the agent project for new work and retains the conversation project across moves and retries", async () => {
  const first = await project(),
    second = await project(),
    a = await agent(first.id);
  const input = {
    agentId: a.id,
    input: "Original project",
    idempotencyKey: id(),
  };
  const original = submit("alice", input);
  expect(JSON.parse(original.payload).folderId).toBe(first.id);
  await api("/agents/" + a.id, { folderId: second.id }, "PATCH");
  expect(submit("alice", input).id).toBe(original.id);
  const reply = submit("alice", {
    agentId: a.id,
    conversationId: original.conversation_id!,
    input: "Continue",
    idempotencyKey: id(),
  });
  expect(JSON.parse(reply.payload).folderId).toBe(first.id);
  const fresh = submit("alice", {
    agentId: a.id,
    input: "New project",
    idempotencyKey: id(),
  });
  expect(JSON.parse(fresh.payload).folderId).toBe(second.id);
  const inbox = submit("alice", {
    agentId: a.id,
    input: "Explicit inbox",
    folderId: null,
    idempotencyKey: id(),
  });
  expect(JSON.parse(inbox.payload).folderId).toBeNull();
  const inboxReply = submit("alice", {
    agentId: a.id,
    conversationId: inbox.conversation_id!,
    input: "Stay in inbox",
    idempotencyKey: id(),
  });
  expect(JSON.parse(inboxReply.payload).folderId).toBeNull();
  expect(
    belongsToProject("child", first.id, [
      { ...first, parent_id: null },
      { id: "child", name: "Child", kind: "folder", parent_id: first.id },
    ]),
  ).toBe(true);
});
it("dismisses failures durably without hiding history or a different owner's work", async () => {
  const a = await agent(),
    run = submit("alice", {
      agentId: a.id,
      input: "Failed task",
      idempotencyKey: id(),
    });
  db.prepare(
    "UPDATE runs SET state='failed',error='Fixture failure' WHERE id=?",
  ).run(run.id);
  expect((await api(`/runs/${run.id}/dismiss`, {}, "POST", "bob")).status).toBe(
    404,
  );
  expect((await api(`/runs/${run.id}/dismiss`, {})).status).toBe(200);
  expect((await api(`/runs/${run.id}/dismiss`, {})).status).toBe(200);
  expect(record(run.id).state).toBe("failed");
  expect(
    (await api("/runs?active=1")).data.some((r: any) => r.id === run.id),
  ).toBe(false);
  expect((await api("/runs")).data.some((r: any) => r.id === run.id)).toBe(
    true,
  );
  expect(
    (await api(`/conversations/${run.conversation_id}`)).data.messages[0]
      .run_state,
  ).toBe("failed");
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM events WHERE run_id=? AND type='attention.dismissed'",
      )
      .get(run.id),
  ).toEqual({ n: 1 });
});
it("cancels waiting work and its pending approval without approving it; rejects stale active cards", async () => {
  const a = await agent(),
    run = submit("alice", {
      agentId: a.id,
      input: "Permission",
      idempotencyKey: id(),
    });
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    run.id,
  );
  const approval = id();
  db.prepare(
    "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,'alice',?,'fixture','{}','pending',?,?)",
  ).run(approval, run.id, now(), now() + 60000);
  expect((await api(`/runs/${run.id}/dismiss`, {})).status).toBe(200);
  expect(record(run.id).state).toBe("cancelled");
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval),
  ).toEqual({ state: "rejected" });
  const active = submit("alice", {
    agentId: a.id,
    input: "Running now",
    idempotencyKey: id(),
  });
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture-worker' WHERE id=?",
  ).run(active.id);
  expect((await api(`/runs/${active.id}/dismiss`, {})).status).toBe(409);
  expect(record(active.id).state).toBe("running");
  const queued = submit("alice", {
    agentId: a.id,
    input: "Not interested",
    idempotencyKey: id(),
  });
  expect((await api(`/runs/${queued.id}/dismiss`, {})).status).toBe(200);
  expect(record(queued.id).state).toBe("cancelled");
});
it("cancels dependent work when its waiting manager is dismissed", async () => {
  const a = await agent();
  const make = (input: string) =>
    submit("alice", { agentId: a.id, input, idempotencyKey: id() });
  const manager = make("Manager"),
    child = make("Child"),
    grandchild = make("Grandchild");
  db.prepare("UPDATE runs SET state='running',worker_id=NULL WHERE id=?").run(
    manager.id,
  );
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    child.id,
  );
  const link = db.prepare("INSERT INTO delegations VALUES(?,?,?,?)");
  link.run(manager.id, "child", child.id, "{}");
  link.run(child.id, "grandchild", grandchild.id, "{}");
  const approval = id();
  db.prepare(
    "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,'alice',?,'child-fixture','{}','pending',?,?)",
  ).run(approval, child.id, now(), now() + 60000);
  expect((await api(`/runs/${manager.id}/dismiss`, {})).status).toBe(200);
  for (const run of [manager, child, grandchild])
    expect(record(run.id).state).toBe("cancelled");
  expect(
    db.prepare("SELECT state FROM approvals WHERE id=?").get(approval),
  ).toEqual({ state: "rejected" });
});
it("migrates existing initial-task projects without assigning another owner's folder or altering old runs", () => {
  const legacy = new Database(":memory:");
  try {
    const root = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(root)
      .filter((f) => f.endsWith(".sql") && Number(f.split("-")[0]) < 16)
      .sort())
      legacy.exec(readFileSync(new URL(file, root), "utf8"));
    for (const [agentId, folderOwner] of [
      ["existing", "alice"],
      ["foreign", "bob"],
    ]) {
      legacy
        .prepare(
          "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,created_at) VALUES(?,'alice',?,?,'openai','old-model','Original instructions',1)",
        )
        .run(agentId, agentId, agentId);
      legacy
        .prepare(
          "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Original project',1)",
        )
        .run(agentId, folderOwner);
      legacy
        .prepare(
          "INSERT INTO runs(id,owner_id,agent_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,'alice',?,'Original request','failed',?,?,1,1)",
        )
        .run(agentId, agentId, agentId, JSON.stringify({ folderId: agentId }));
      legacy
        .prepare(
          "INSERT INTO agent_creations VALUES('alice',?,'original-hash',?,?,1)",
        )
        .run(agentId, agentId, agentId);
    }
    legacy.exec(
      readFileSync(new URL("016-projects-and-attention.sql", root), "utf8"),
    );
    expect(
      legacy
        .prepare(
          "SELECT folder_id,instructions FROM agents WHERE id='existing'",
        )
        .get(),
    ).toEqual({ folder_id: "existing", instructions: "Original instructions" });
    expect(
      legacy.prepare("SELECT folder_id FROM agents WHERE id='foreign'").get(),
    ).toEqual({ folder_id: null });
    expect(
      legacy
        .prepare(
          "SELECT input,state,attention_dismissed_at FROM runs WHERE id='existing'",
        )
        .get(),
    ).toEqual({
      input: "Original request",
      state: "failed",
      attention_dismissed_at: null,
    });
  } finally {
    legacy.close();
  }
});
