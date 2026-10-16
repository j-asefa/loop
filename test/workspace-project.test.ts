import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
import { belongsToProject } from "../src/shared/projects";

const dir = mkdtempSync(join(tmpdir(), "loop-workspace-project-"));
vi.stubEnv("LOOP_PROFILE", "server");
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, now } = await import("../src/server/db");
const { Problem } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { mobile } = await import("../src/server/mobile-routes");
const { briefs } = await import("../src/server/briefs/routes");
const { recordChange } = await import("../src/server/project-changes");
const { withTestAdapter } = await import("../src/server/providers");
const { runDueBriefs } = await import("../src/server/briefs/generate");
const { briefForAgent, agentBriefAccess } =
  await import("../src/server/briefs/tool");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", mobile, core, workspace, briefs);
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
    recordChange(owner, folder, "prompt", message, cid);
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
  const changes = db
    .prepare(
      "SELECT kind,ref FROM project_changes WHERE owner_id=? AND project_id=?",
    )
    .all(f.owner, project.id);
  for (const run of [a, b]) {
    expect(changes).toContainEqual({ kind: "result", ref: run.artifact });
    expect(changes).toContainEqual({ kind: "prompt", ref: run.message });
  }
  for (const run of [named, nested, mixed, foreign])
    expect(JSON.stringify(changes)).not.toContain(run.artifact);
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
  expect((await api(other.owner, `/projects/${project.id}/brief`)).status).toBe(
    404,
  );
  expect(
    (await api(other.owner, `/projects/status?project=${project.id}`)).status,
  ).toBe(404);
  expect(
    (await api(f.owner, `/folders/${project.id}`, { name: "Changed" }, "PATCH"))
      .status,
  ).toBe(400);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM project_changes WHERE owner_id=? AND project_id=?",
      )
      .get(f.owner, project.id),
  ).toEqual({ n: changes.length });
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

it("enables, generates and serves a Workspace brief with live status and agent access", async () => {
  const f = fixture();
  const runs = [f.run(), f.run(), f.run()];
  const project = (await api(f.owner, "/bootstrap")).data.folders.find(
    (p: any) => p.is_workspace,
  ).id;
  const root = `/projects/${project}/brief`;
  expect((await api(f.owner, root)).data.settings.enabled).toBe(false);
  expect(
    (
      await api(
        f.owner,
        root + "/settings",
        { enabled: true, connectionId: f.connection, model: "fixture" },
        "PUT",
      )
    ).status,
  ).toBe(200);
  const restore = withTestAdapter("openai", {
    models: async () => [],
    async *stream(_secret, input) {
      expect(input.messages[0].content).toContain(runs[0].artifact);
      yield {
        toolCall: {
          id: "fixture",
          name: "submit_brief",
          arguments: {
            headline: {
              text: "Workspace review is ready",
              cite: [{ ref: "res_" + runs[0].artifact }],
            },
            items: [
              {
                kind: "state",
                text: "The unassigned tasks are reviewed.",
                cite: [{ ref: "res_" + runs[0].artifact }],
              },
            ],
          },
        },
      };
    },
  });
  try {
    expect(await runDueBriefs()).toBe(1);
  } finally {
    restore();
  }
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
  const page = (await api(f.owner, root)).data;
  expect(page.headline.text).toBe("Workspace review is ready");
  expect(page.sources["res_" + runs[0].artifact].conversation).toBe(
    runs[0].conversation,
  );
  expect(page.needs_you).toContainEqual({
    kind: "approval",
    ref: approval,
    conversation: pending.conversation,
  });
  const status = (await api(f.owner, `/projects/status?project=${project}`))
    .data.items;
  expect(status).toHaveLength(1);
  expect(status[0]).toMatchObject({
    name: "Workspace",
    status: "needs_you",
    counts: { needs: 1, working: 0 },
    brief: {
      headline: "Workspace review is ready",
      highlights: {
        progress: [{ text: "The unassigned tasks are reviewed." }],
      },
    },
  });
  expect(
    (
      await api(
        f.owner,
        `/projects/${project}/status-action?key=approval:${approval}`,
      )
    ).data.conversation,
  ).toBe(pending.conversation);
  const run = db
    .prepare("SELECT * FROM runs WHERE id=?")
    .get(pending.id) as any;
  expect(agentBriefAccess(run)).toBe(true);
  expect(JSON.parse(briefForAgent(run)).project).toBe(project);
  expect(
    agentBriefAccess(
      db.prepare("SELECT * FROM runs WHERE id=?").get(named.id) as any,
    ),
  ).toBe(false);
  await api(
    f.owner,
    root + "/settings",
    { enabled: false, connectionId: f.connection, model: "fixture" },
    "PUT",
  );
  expect(
    (await api(f.owner, `/projects/status?project=${project}`)).data.items[0]
      .brief.state,
  ).toBe("off");
  expect(agentBriefAccess(run)).toBe(false);
});

it("keeps Workspace history and citations correct when work is filed and moved back", async () => {
  const f = fixture();
  const project = (await api(f.owner, "/bootstrap")).data.folders.find(
    (p: any) => p.is_workspace,
  ).id;
  const r = f.run();
  const rows = (ref: string, target: string) =>
    db
      .prepare(
        "SELECT kind FROM project_changes WHERE owner_id=? AND project_id=? AND ref=? ORDER BY seq",
      )
      .all(f.owner, target, ref) as { kind: string }[];
  expect(rows(r.message, project)).toContainEqual({ kind: "prompt" });
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    f.named,
    r.conversation,
  );
  expect(rows(r.artifact, project).at(-1)).toEqual({ kind: "tombstone" });
  expect(rows(r.artifact, f.named).at(-1)).toEqual({ kind: "result" });
  db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
    r.conversation,
  );
  expect(rows(r.artifact, f.named).at(-1)).toEqual({ kind: "tombstone" });
  expect(rows(r.artifact, project).at(-1)).toEqual({ kind: "result" });
  const loose = f.run(f.loose);
  db.prepare("UPDATE folders SET parent_id=? WHERE id=?").run(f.named, f.loose);
  expect(rows(loose.artifact, project).at(-1)).toEqual({ kind: "tombstone" });
  expect(rows(loose.artifact, f.named).at(-1)).toEqual({ kind: "result" });
  db.prepare("UPDATE folders SET parent_id=NULL WHERE id=?").run(f.loose);
  expect(rows(loose.artifact, project).at(-1)).toEqual({ kind: "result" });
  const standalone = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,content,created_at,updated_at) VALUES(?,?,'Unfiled note','markdown','Keep this note.',?,?)",
  ).run(standalone, f.owner, now(), now());
  db.prepare("UPDATE artifacts SET folder_id=? WHERE id=?").run(
    f.named,
    standalone,
  );
  expect(rows(standalone, project).at(-1)).toEqual({ kind: "tombstone" });
  db.prepare("UPDATE artifacts SET folder_id=NULL WHERE id=?").run(standalone);
  expect(rows(standalone, project).at(-1)).toEqual({ kind: "result" });
});
