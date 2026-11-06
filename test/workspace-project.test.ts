import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
import { belongsToProject } from "../src/shared/projects";

const dir = mkdtempSync(join(tmpdir(), "loop-workspace-project-"));
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, now } = await import("../src/server/db");
const { Problem } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { mobile } = await import("../src/server/mobile-routes");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", mobile, core, workspace);
app.use((error: any, _req: any, res: any, _next: any) =>
  res
    .status(
      error instanceof Problem
        ? error.status
        : error instanceof ZodError
          ? 400
          : 500,
    )
    .json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function api(
  owner: string,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: r.status, data: (await r.json()) as any };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const owner = id(),
    agent = id(),
    connection = id(),
    named = id(),
    loose = id(),
    nested = id();
  const folder = db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,?,?,?)",
  );
  folder.run(named, owner, null, "project", "Release", now());
  folder.run(loose, owner, null, "folder", "Notes", now());
  folder.run(nested, owner, loose, "project", "Independent project", now());
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected','[{\"id\":\"fixture\"}]',?)",
  ).run(connection, owner, seal("fixture-only", owner), now());
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'openai',?,'fixture',?)",
  ).run(agent, owner, agent, agent, connection, now());
  const run = (
    folder: string | null = null,
    state = "completed",
    conversation?: string,
  ) => {
    const cid = conversation ?? id(),
      run = id(),
      message = id(),
      artifact = id();
    if (!conversation)
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Workspace task',?)",
      ).run(cid, owner, agent, now());
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at,worker_id) VALUES(?,?,?,?,'Review the workspace',?,?,?,?,?,'fixture')",
    ).run(
      run,
      owner,
      agent,
      cid,
      state,
      run,
      JSON.stringify({ folderId: folder }),
      now(),
      now(),
    );
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Review the workspace',?)",
    ).run(message, owner, cid, run, now());
    db.prepare(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,folder_id,created_at,updated_at) VALUES(?,?,?,?,?,'Workspace result','markdown','Workspace work is ready.',?,?,?)",
    ).run(artifact, owner, agent, cid, run, folder, now(), now());
    return { id: run, conversation: cid, message, artifact };
  };
  return { owner, agent, connection, named, loose, nested, run };
}

it("creates one persistent Workspace per owner and recovers only its existing unassigned work", async () => {
  const f = fixture(),
    other = fixture();
  const a = f.run(),
    b = f.run(f.loose),
    named = f.run(f.named),
    nested = f.run(f.nested);
  const foreign = other.run();
  // Mixed run history must keep each run's original fallback scope.
  const mixed = f.run(f.named, "completed", a.conversation);
  const bootstrap = (await api(f.owner, "/bootstrap")).data;
  const project = bootstrap.folders.find((p: any) => p.is_workspace);
  expect(project).toMatchObject({
    name: "Workspace",
    kind: "project",
    parent_id: null,
  });
  expect(
    (await api(f.owner, "/bootstrap")).data.folders.filter(
      (p: any) => p.is_workspace,
    ),
  ).toEqual([project]);
  expect(
    db
      .prepare("SELECT project_id FROM conversations WHERE id=?")
      .get(a.conversation),
  ).toEqual({ project_id: null });
  expect(db.prepare("SELECT payload FROM runs WHERE id=?").get(a.id)).toEqual({
    payload: JSON.stringify({ folderId: null }),
  });
  expect(belongsToProject(null, project.id, bootstrap.folders)).toBe(true);
  expect(belongsToProject(f.loose, project.id, bootstrap.folders)).toBe(true);
  expect(belongsToProject(f.named, project.id, bootstrap.folders)).toBe(false);
  expect(belongsToProject(f.nested, project.id, bootstrap.folders)).toBe(false);
  expect(belongsToProject("missing", project.id, bootstrap.folders)).toBe(
    false,
  );
  const feed = (await api(f.owner, `/feed?folder=${project.id}`)).data.items;
  expect(feed.map((r: any) => r.conversation_id)).toContain(b.conversation);
  expect(feed.map((r: any) => r.conversation_id)).not.toContain(a.conversation); // latest run is in Release
  expect(feed.map((r: any) => r.conversation_id)).not.toContain(
    nested.conversation,
  );
  const results = (await api(f.owner, `/results?folder=${project.id}`)).data
    .items;
  expect(results.map((r: any) => r.id).sort()).toEqual(
    [a.artifact, b.artifact].sort(),
  );
  expect(
    (await api(f.owner, `/folders/${project.id}`, { name: "Changed" }, "PATCH"))
      .status,
  ).toBe(400);
  await api(f.owner, `/messages/${a.message}/saved`, {});
  await api(f.owner, `/messages/${named.message}/saved`, {});
  const saved = (await api(f.owner, `/saved?folder=${project.id}`)).data.items;
  expect(saved.map((r: any) => r.key)).toEqual(["m:" + a.message]);
  const created = await api(f.owner, "/folders", {
    name: "Next release",
    kind: "project",
    parentId: project.id,
  });
  expect(created.status).toBe(201);
  expect(created.data.parent_id).toBeNull();
  expect(
    belongsToProject(created.data.id, project.id, [
      ...bootstrap.folders,
      created.data,
    ]),
  ).toBe(false);
});

it("keeps live Workspace counts scoped to the current project", async () => {
  const f = fixture();
  const project = (await api(f.owner, "/bootstrap")).data.folders.find(
    (p: any) => p.is_workspace,
  ).id;
  const pending = f.run(null, "awaiting_approval"),
    approval = id();
  db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,'pending',NULL,?,?)").run(
    approval,
    f.owner,
    pending.id,
    "digest",
    "{}",
    now(),
    now() + 60_000,
  );
  const named = f.run(f.named, "running");
  // A conversation's explicit project also wins over an unassigned run.
  const filed = f.run(null, "running");
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    f.named,
    filed.conversation,
  );
  const summaries = (await api(f.owner, "/projects/summary")).data.items;
  expect(summaries.find((p: any) => p.id === project)).toMatchObject({
    working: 0,
    needs: 1,
  });
  expect(summaries.find((p: any) => p.id === f.named)).toMatchObject({
    working: 2,
    needs: 0,
  });
});

it("keeps results scoped when artifacts and folders move", async () => {
  const f = fixture();
  const project = (await api(f.owner, "/bootstrap")).data.folders.find(
    (p: any) => p.is_workspace,
  ).id;
  const r = f.run();
  const results = async (folder: string) =>
    (await api(f.owner, `/results?folder=${folder}`)).data.items.map(
      (item: any) => item.id,
    );
  expect(await results(project)).toContain(r.artifact);
  db.prepare("UPDATE artifacts SET folder_id=? WHERE id=?").run(
    f.named,
    r.artifact,
  );
  expect(await results(project)).not.toContain(r.artifact);
  expect(await results(f.named)).toContain(r.artifact);
  db.prepare("UPDATE artifacts SET folder_id=NULL WHERE id=?").run(r.artifact);
  expect(await results(project)).toContain(r.artifact);
  const loose = f.run(f.loose);
  db.prepare("UPDATE folders SET parent_id=? WHERE id=?").run(f.named, f.loose);
  expect(await results(project)).not.toContain(loose.artifact);
  expect(await results(f.named)).toContain(loose.artifact);
  db.prepare("UPDATE folders SET parent_id=NULL WHERE id=?").run(f.loose);
  expect(await results(project)).toContain(loose.artifact);
});

it("executes ordinary prompts without a brief and rejects retired tool receipts", async () => {
  const f = fixture();
  const { submit, executeAgent } = await import("../src/server/agent-runtime");
  const { nativeBindings, invokeNative } =
    await import("../src/server/native-tools");
  const { withTestAdapter } = await import("../src/server/providers");
  const submitted = submit(f.owner, {
    agentId: f.agent,
    input: "Only the original request",
    idempotencyKey: id(),
  });
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
  ).run(submitted.id);
  const run = db
    .prepare("SELECT * FROM runs WHERE id=?")
    .get(submitted.id) as any;
  expect(nativeBindings(run).map((t) => t.tool)).not.toContain("loop_brief");
  const oldBinding = {
    name: "loop_brief",
    tool: "loop_brief",
    connectionId: "__loop__",
    description: "Retired",
    inputSchema: {},
  };
  db.prepare(
    "INSERT INTO native_calls(run_id,call_id,tool,arguments,result) VALUES(?,?,'loop_brief','{}',?)",
  ).run(
    run.id,
    "old-call",
    JSON.stringify({ content: [{ type: "text", text: "Old brief" }] }),
  );
  await expect(invokeNative(run, oldBinding, "old-call", {})).rejects.toThrow(
    "Native tool is unavailable",
  );
  const prompts: string[] = [];
  const restore = withTestAdapter("openai", {
    models: async () => [],
    async *stream(_secret, input) {
      prompts.push(input.messages.findLast((m) => m.role === "user")!.content);
      expect(input.tools?.map((t) => t.name)).not.toContain("loop_brief");
      yield { text: "Completed normally." };
    },
  });
  try {
    expect(await executeAgent(run)).toBe(true);
    expect(prompts).toEqual(["Only the original request"]);
  } finally {
    restore();
  }
});
