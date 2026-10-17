import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
const dir = mkdtempSync(join(tmpdir(), "loop-brief-routes-"));
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id, now } = await import("../src/server/db");
const { Problem } = await import("../src/server/domain");
const { briefs } = await import("../src/server/briefs/routes");
const { applyOutput } = await import("../src/server/briefs/apply");
const { readState } = await import("../src/server/briefs/store");
const { serveBrief } = await import("../src/server/briefs/serve");
const { setSaved } = await import("../src/server/mobile-return");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", briefs);
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
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api${path}`,
    {
      method,
      headers: { "x-owner": owner, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return { status: response.status, data: (await response.json()) as any };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const owner = id(),
    project = id(),
    connection = id(),
    agent = id(),
    conversation = id(),
    run = id(),
    artifact = id(),
    message = id(),
    prompt = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Brief project',0)",
  ).run(project, owner);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','never-return-this-secret','connected','[{\"id\":\"fixture\"}]',0)",
  ).run(connection, owner);
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'openai',?,'fixture',0)",
  ).run(agent, owner, agent, agent, connection);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Architecture discussion',?,0)",
  ).run(conversation, owner, agent, project);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Implement','completed',?,?,1,2)",
  ).run(
    run,
    owner,
    agent,
    conversation,
    run,
    JSON.stringify({ folderId: project }),
  );
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Use SQLite.',1)",
  ).run(prompt, owner, conversation, run);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','SQLite is implemented.',2)",
  ).run(message, owner, conversation, run);
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,'Storage result','markdown','SQLite is implemented.',?,2,2)",
  ).run(
    artifact,
    owner,
    agent,
    conversation,
    run,
    JSON.stringify({ messageId: message }),
  );
  const root = `/projects/${project}/brief`;
  const output = {
    headline: { text: "Storage is ready", cite: [{ ref: "res_" + artifact }] },
    items: [
      {
        kind: "state",
        text: "SQLite is implemented",
        cite: [{ ref: "res_" + artifact }],
      },
    ],
  };
  function publish(value: unknown = output) {
    const state = readState(owner, project);
    const seq = (
      db
        .prepare(
          "SELECT max(seq) seq FROM project_changes WHERE owner_id=? AND project_id=?",
        )
        .get(owner, project) as { seq: number }
    ).seq;
    return applyOutput(owner, project, value, {
      builtOnVersion: state.current_version,
      ownerEditRev: state.owner_edit_rev,
      basisThrough: seq,
    });
  }
  return {
    owner,
    project,
    connection,
    agent,
    conversation,
    run,
    artifact,
    message,
    prompt,
    root,
    output,
    publish,
    state: () => readState(owner, project),
    get: () => api(owner, root),
    request: (path: string, method = "GET", body?: unknown) =>
      api(owner, root + path, method, body),
  };
}

it("scopes every production route to an owned project before parsing input", async () => {
  const w = fixture(),
    other = fixture();
  for (const [path, method, body] of [
    ["", "GET"],
    ["/settings", "PUT", {}],
    ["/goal", "PUT", {}],
    ["/ack", "POST", {}],
    ["/items?kind=decision", "GET"],
    ["/items/missing", "PATCH", {}],
    ["/items", "POST", {}],
    ["/versions", "GET"],
    ["/decision-sources", "GET"],
    ["/evidence?item=headline", "GET"],
  ] as [string, string, unknown?][])
    expect((await api(other.owner, w.root + path, method, body)).status).toBe(
      404,
    );
  const folder = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'folder','Not project',0)",
  ).run(folder, w.owner);
  expect((await api(w.owner, `/projects/${folder}/brief`)).status).toBe(404);
  expect((await w.get()).data.settings.enabled).toBe(false);
  expect(JSON.stringify((await w.get()).data)).not.toContain(
    "never-return-this-secret",
  );
});

it("accepts connected Codex and Claude subscriptions and rejects unavailable models or billing paths", async () => {
  const w = fixture();
  for (const provider of ["codex", "anthropic"]) {
    db.prepare("UPDATE connections SET provider=?,metadata=? WHERE id=?").run(
      provider,
      JSON.stringify({ authMode: "subscription" }),
      w.connection,
    );
    const settings = {
      enabled: true,
      connectionId: w.connection,
      model: "fixture",
    };
    expect((await w.request("/settings", "PUT", settings)).status).toBe(200);
    expect(w.state().connection_id).toBe(w.connection);
    if (provider === "anthropic") {
      db.prepare("UPDATE connections SET models=? WHERE id=?").run(
        JSON.stringify([{ id: "native-default" }, { id: "fixture" }]),
        w.connection,
      );
      const refused = await w.request("/settings", "PUT", {
        ...settings,
        model: "native-default",
      });
      expect(refused.status).toBe(400);
      expect(refused.data.error).toContain("specific Claude model");
      expect(w.state().model).toBe("fixture");
    }
    expect(
      (await w.request("/settings", "PUT", { ...settings, model: "unknown" }))
        .status,
    ).toBe(400);
    db.prepare("UPDATE connections SET status='needs_sign_in' WHERE id=?").run(
      w.connection,
    );
    expect((await w.request("/settings", "PUT", settings)).status).toBe(400);
    db.prepare("UPDATE connections SET status='connected' WHERE id=?").run(
      w.connection,
    );
  }
  db.prepare("UPDATE connections SET provider='pi',metadata=? WHERE id=?").run(
    JSON.stringify({ loopHarness: "pi", authMode: "native-existing" }),
    w.connection,
  );
  expect(
    (
      await w.request("/settings", "PUT", {
        enabled: true,
        connectionId: w.connection,
        model: "fixture",
      })
    ).status,
  ).toBe(400);
});

it("refuses malformed connection metadata without enabling generation", async () => {
  const w = fixture();
  const settings = {
    enabled: true,
    connectionId: w.connection,
    model: "fixture",
  };
  for (const metadata of ["{", "null", "[]", '"subscription"', "7"]) {
    db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
      metadata,
      w.connection,
    );
    expect((await w.request("/settings", "PUT", settings)).status).toBe(400);
    expect(w.state().enabled).toBe(0);
  }
  db.prepare("UPDATE connections SET metadata='{}' WHERE id=?").run(
    w.connection,
  );
  expect((await w.request("/settings", "PUT", settings)).status).toBe(200);
});

it("validates connection settings and fences a previous generation when settings change", async () => {
  const w = fixture(),
    other = fixture(),
    settings = { enabled: true, connectionId: w.connection, model: "fixture" };
  expect(
    (
      await w.request("/settings", "PUT", {
        ...settings,
        connectionId: other.connection,
      })
    ).status,
  ).toBe(404);
  expect(
    (await w.request("/settings", "PUT", { ...settings, model: "invented" }))
      .status,
  ).toBe(400);
  db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
    JSON.stringify({ authMode: "subscription" }),
    w.connection,
  );
  expect((await w.request("/settings", "PUT", settings)).status).toBe(400);
  db.prepare("UPDATE connections SET metadata='{}' WHERE id=?").run(
    w.connection,
  );
  expect((await w.request("/settings", "PUT", settings)).status).toBe(200);
  expect(w.state().due_at).toBeGreaterThan(0);
  db.prepare(
    "UPDATE brief_state SET generation_id='old',lease_until=? WHERE project_id=?",
  ).run(now() + 60_000, w.project);
  expect(
    (
      await w.request("/settings", "PUT", {
        enabled: false,
        connectionId: null,
        model: null,
      })
    ).status,
  ).toBe(200);
  expect(w.state()).toMatchObject({
    enabled: 0,
    generation_id: null,
    lease_until: null,
    due_at: null,
  });
});

it("goal edits fence generation, record a change and leave first-generation eligibility intact", async () => {
  const w = fixture();
  expect(
    (await w.request("/goal", "PUT", { text: "g".repeat(201) })).status,
  ).toBe(400);
  expect(
    (await w.request("/goal", "PUT", { text: "Ship the storage layer" })).data
      .goal,
  ).toEqual({ text: "Ship the storage layer" });
  expect(w.state()).toMatchObject({
    owner_edit_rev: 1,
    current_version: 0,
    basis_through: 0,
  });
  const changes = db
    .prepare(
      "SELECT kind,ref FROM project_changes WHERE project_id=? AND kind='brief_edit'",
    )
    .all(w.project);
  expect(changes).toEqual([{ kind: "brief_edit", ref: "goal" }]);
  await w.request("/goal", "PUT", { text: "Ship the storage layer" });
  expect(w.state().owner_edit_rev).toBe(1);
  await w.request("/goal", "PUT", { text: null });
  expect(w.state()).toMatchObject({ goal: null, owner_edit_rev: 2 });
});

it("acknowledges only existing versions, monotonically, without changing the brief", async () => {
  const w = fixture();
  w.publish();
  expect((await w.request("/ack", "POST", { version: 2 })).status).toBe(409);
  expect((await w.request("/ack", "POST", { version: 1 })).status).toBe(200);
  await w.request("/ack", "POST", { version: 0 });
  expect((await w.get()).data).toMatchObject({
    version: 1,
    acknowledged_version: 1,
    changes: [],
  });
  expect(w.state().owner_edit_rev).toBe(0);
});

it("PATCH pins edited words, versions the view and rejects foreign items and invalid statuses", async () => {
  const w = fixture(),
    other = fixture();
  w.publish();
  other.publish();
  const item = (await w.get()).data.state[0],
    foreign = (await other.get()).data.state[0];
  expect(
    (await w.request(`/items/${foreign.id}`, "PATCH", { text: "Steal" }))
      .status,
  ).toBe(404);
  expect(
    (await w.request(`/items/${item.id}`, "PATCH", { status: "answered" }))
      .status,
  ).toBe(400);
  expect(
    (await w.request(`/items/${item.id}`, "PATCH", { status: "" })).status,
  ).toBe(400);
  expect(
    (await w.request(`/items/${item.id}`, "PATCH", { why: "wrong kind" }))
      .status,
  ).toBe(400);
  const edited = await w.request(`/items/${item.id}`, "PATCH", {
    text: "Owner correction",
    pinned: false,
  });
  expect(edited.status).toBe(200);
  expect(edited.data.state[0]).toMatchObject({
    text: "Owner correction",
    pinned: true,
    author: "owner",
    last_version: 2,
  });
  expect(edited.data.changes).toContainEqual(
    expect.objectContaining({ id: item.id, pinned: true }),
  );
  expect(w.state().owner_edit_rev).toBe(1);
  expect(
    db.prepare("SELECT owner_rev FROM brief_items WHERE id=?").get(item.id),
  ).toEqual({ owner_rev: 1 });
  const unpinned = await w.request(`/items/${item.id}`, "PATCH", {
    pinned: false,
  });
  expect(unpinned.data).toMatchObject({ version: 3, pins: [] });
  expect(
    (await w.request("/versions")).data.items.map((v: any) => v.version),
  ).toEqual([3, 2, 1]);
});

it("creates owner decisions only from owned choice evidence and retains them through generation", async () => {
  const w = fixture(),
    other = fixture();
  const decision = (ref: string) => ({
    kind: "decision",
    text: "Use SQLite",
    why: "Durability",
    cite: [{ ref }],
  });
  expect(
    (await w.request("/items", "POST", decision("res_" + w.artifact))).status,
  ).toBe(400);
  expect(
    (await w.request("/items", "POST", decision("msg_" + other.prompt))).status,
  ).toBe(400);
  const byMessage = await w.request(
    "/items",
    "POST",
    decision("msg_" + w.prompt),
  );
  expect(byMessage.status).toBe(201);
  expect(byMessage.data.decisions[0]).toMatchObject({
    evidence: "owner_message",
    decided_by: "you",
    author: "owner",
    pinned: true,
  });
  setSaved(w.owner, w.message, true);
  const bySaved = await w.request(
    "/items",
    "POST",
    decision("saved_" + w.message),
  );
  expect(
    bySaved.data.decisions.find((item: any) => item.id === bySaved.data.itemId)
      .evidence,
  ).toBe("owner_saved");
  const byResult = await w.request(
    "/items",
    "POST",
    decision("res_" + w.artifact),
  );
  expect(byResult.status).toBe(201);
  const item = byResult.data.decisions.find(
    (item: any) => item.id === byResult.data.itemId,
  );
  expect(item.evidence).toBe("owner_saved");
  const result = w.publish({
    ...w.output,
    items: [
      {
        id: item.id,
        kind: item.kind,
        text: item.text,
        why: item.why,
        cite: item.cite,
        evidence: item.evidence,
        decided_by: "you",
      },
    ],
  });
  expect(result.outcome).toBe("published");
  expect("errors" in result && result.errors).toEqual([]);
});

it("keeps unsupported automated messages out of owner decision evidence and source choices", async () => {
  const w = fixture();
  db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(
    JSON.stringify({ automation: { kind: "fixture" } }),
    w.prompt,
  );
  expect(
    (
      await w.request("/items", "POST", {
        kind: "decision",
        text: "Not my choice",
        cite: [{ ref: "msg_" + w.prompt }],
      })
    ).status,
  ).toBe(400);
  expect((await w.request("/decision-sources")).data.items).toEqual([]);
  setSaved(w.owner, w.message, true);
  expect(
    (await w.request("/decision-sources")).data.items.some(
      (source: any) => source.ref === "res_" + w.artifact,
    ),
  ).toBe(true);
});

it("resolves citation navigation to the exact message without returning unowned targets", async () => {
  const w = fixture(),
    other = fixture();
  w.publish();
  const ref = "res_" + w.artifact;
  expect((await w.get()).data.sources[ref]).toMatchObject({
    conversation: w.conversation,
    message: w.message,
    title: "Architecture discussion",
  });
  db.prepare("UPDATE artifacts SET metadata=? WHERE id=?").run(
    JSON.stringify({ messageId: other.message }),
    w.artifact,
  );
  expect((await w.get()).data.sources[ref].message).toBeNull();
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(w.artifact);
  expect((await w.get()).data.sources[ref]).toBeUndefined();
});

it("opens Status evidence for the displayed headline version and exact item without acknowledging", async () => {
  const w = fixture();
  w.publish();
  const first = (await w.get()).data;
  const item = first.state[0];
  w.publish({
    headline: { text: "A newer update", cite: [{ ref: "msg_" + w.prompt }] },
    items: [],
  });
  const before = w.state();
  const headline = await w.request("/evidence?item=headline&version=1");
  expect(headline.status).toBe(200);
  expect(headline.data).toMatchObject({
    text: "Storage is ready",
    sources: {
      ["res_" + w.artifact]: {
        conversation: w.conversation,
        message: w.message,
        kind: "result",
        run: w.run,
      },
    },
  });
  const detail = await w.request("/evidence?item=" + item.id);
  expect(detail.data.text).toBe(item.text);
  expect(detail.data.cite).toEqual(item.cite);
  expect(w.state()).toEqual(before);
  expect(
    db
      .prepare("SELECT count(*) n FROM brief_acks WHERE owner_id=?")
      .get(w.owner),
  ).toEqual({ n: 0 });
  expect((await w.request("/evidence?item=headline&version=999")).status).toBe(
    404,
  );
  expect((await w.request("/evidence?item=missing")).status).toBe(404);
  const other = fixture();
  expect((await other.request("/evidence?item=" + item.id)).status).toBe(404);
  // A formerly cited result is never replaced with an unrelated source.
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(w.artifact);
  expect((await w.request("/evidence?item=" + item.id)).data).toMatchObject({
    cite: item.cite,
    sources: {},
  });
});

it("exposes exact run destinations for observed checks in Status evidence", async () => {
  const w = fixture(),
    verification = id();
  db.prepare(
    "INSERT INTO run_verifications(id,owner_id,run_id,kind,tools,command,status,exit_code,observed_at) VALUES(?,?,?,'test','[\"vitest\"]','vitest','passed',0,?)",
  ).run(verification, w.owner, w.run, now());
  expect(
    w.publish({
      headline: {
        text: "Checks passed",
        cite: [{ ref: "ver_" + verification }],
      },
      items: [],
    }).outcome,
  ).toBe("published");
  const result = await w.request("/evidence?item=headline&version=1");
  expect(result.data.sources["ver_" + verification]).toMatchObject({
    kind: "verification",
    run: w.run,
    conversation: w.conversation,
  });
});

it("pages the full ledger and shows superseded replacement text without dropping rows", async () => {
  const w = fixture();
  for (let n = 0; n < 55; n++) {
    const response = await w.request("/items", "POST", {
      kind: "decision",
      text: `Decision ${n}`,
      cite: [{ ref: "msg_" + w.prompt }],
    });
    expect(response.status).toBe(201);
  }
  const brief = (await w.get()).data;
  expect(brief.decisions).toHaveLength(20);
  expect(brief.overflow.decisions).toBe(35);
  const page = (await w.request("/items?kind=decision")).data;
  expect(page.items).toHaveLength(50);
  const rest = (await w.request("/items?kind=decision&before=" + page.before))
    .data;
  expect(rest.items).toHaveLength(5);
  expect(
    new Set([...page.items, ...rest.items].map((item) => item.id)).size,
  ).toBe(55);
  const [newer, older] = page.items;
  db.prepare("UPDATE brief_items SET supersedes=? WHERE id=?").run(
    older.id,
    newer.id,
  );
  await w.request(`/items/${older.id}`, "PATCH", { status: "superseded" });
  const history = (await w.request("/items?kind=decision&status=superseded"))
    .data;
  expect(history.items[0].id).toBe(older.id);
  expect(history.replacements[older.id]).toBe(newer.text);
  expect((await w.request("/items?kind=decision&before=invalid")).status).toBe(
    400,
  );
  const versions = (await w.request("/versions")).data;
  expect(versions.items).toHaveLength(50);
  expect(
    (await w.request("/versions?before=" + versions.before)).data.items,
  ).toHaveLength(6);
});

it("owner edits discard a model generation captured before the edit", async () => {
  const w = fixture();
  w.publish();
  const captured = w.state(),
    item = serveBrief(w.owner, w.project).state[0];
  await w.request(`/items/${item.id}`, "PATCH", { text: "Owner wins" });
  const current = w.state();
  expect(
    applyOutput(w.owner, w.project, w.output, {
      builtOnVersion: captured.current_version,
      ownerEditRev: captured.owner_edit_rev,
      basisThrough: current.basis_through + 1,
    }),
  ).toMatchObject({ outcome: "discarded" });
  expect((await w.get()).data.state[0].text).toBe("Owner wins");
});

it("exposes exact Feed approval targets and failed sends without a thread", async () => {
  const w = fixture(),
    approval = id(),
    scheduled = id();
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(w.run);
  db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,'pending',NULL,?,?)").run(
    approval,
    w.owner,
    w.run,
    id(),
    '{"tool":"apply design"}',
    now(),
    now() + 100_000,
  );
  db.prepare(
    "INSERT INTO scheduled_sends(id,owner_id,agent_id,folder_id,folder_chosen,input,idempotency_key,send_at,state,created_at) VALUES(?,?,?,?,1,'Send report',?,?,'failed',?)",
  ).run(scheduled, w.owner, w.agent, w.project, id(), now(), now());
  const { data, status } = await w.get();
  expect(status).toBe(200);
  expect(data.needs_you).toEqual(
    expect.arrayContaining([
      { kind: "approval", ref: approval, conversation: w.conversation },
      { kind: "not_sent", ref: scheduled, conversation: "" },
    ]),
  );
  expect(data.attention[approval]).toEqual({
    conversation: w.conversation,
    message: w.message,
  });
  expect(data.attention[scheduled]).toEqual({
    conversation: "",
    message: null,
  });
});

it("does not skip or repeat ledger items when another device edits between pages", async () => {
  const w = fixture(),
    ids: string[] = [];
  for (let n = 0; n < 55; n++) {
    const response = await w.request("/items", "POST", {
      kind: "decision",
      text: `Choice ${n}`,
      cite: [{ ref: "msg_" + w.prompt }],
    });
    expect(response.status).toBe(201);
    ids.push(response.data.itemId);
  }
  const first = (await w.request("/items?kind=decision")).data;
  expect(first.items).toHaveLength(50);
  expect(first.items.some((item: any) => item.id === ids[0])).toBe(false);
  expect(
    (
      await w.request(`/items/${ids[0]}`, "PATCH", {
        text: "Updated on another device",
      })
    ).status,
  ).toBe(200);
  expect(
    (await w.request(`/items/${ids[54]}`, "PATCH", { pinned: false })).status,
  ).toBe(200);
  const rest = (await w.request("/items?kind=decision&before=" + first.before))
    .data;
  expect(rest.before).toBeNull();
  expect(rest.items).toHaveLength(5);
  expect(rest.items.find((item: any) => item.id === ids[0]).text).toBe(
    "Updated on another device",
  );
  expect(
    new Set([...first.items, ...rest.items].map((item) => item.id)).size,
  ).toBe(55);
});

it("serves the same latest generation accounting on Brief and Status, scoped to its owner", async () => {
  const w = fixture(),
    other = fixture();
  w.publish();
  expect((await w.get()).data.generation_usage).toBeNull();
  const usage = {
    at: now(),
    model: "fixture",
    outcome: "published",
    attempts: 2,
    reported_attempts: 2,
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
  };
  db.prepare(
    "INSERT INTO brief_generation_usage(generation_id,owner_id,project_id,started_at,usage) VALUES(?,?,?,?,?)",
  ).run(id(), w.owner, w.project, now(), JSON.stringify(usage));
  const { projectStatuses } = await import("../src/server/project-status");
  expect((await w.get()).data.generation_usage).toEqual(usage);
  expect(
    projectStatuses(w.owner).items.find((item) => item.id === w.project)?.brief
      .generation_usage,
  ).toEqual(usage);
  // Editing does not spend tokens or erase the last generation.
  await w.request("/goal", "PUT", { text: "An owner edit" });
  expect((await w.get()).data.generation_usage).toEqual(usage);
  expect((await other.get()).data.generation_usage).toBeNull();
  expect((await api(other.owner, w.root)).status).toBe(404);
  expect(
    projectStatuses(other.owner).items.some((item) => item.id === w.project),
  ).toBe(false);
});

it("serves original requests and compact wording without mistaking changed quotes for owner language", async () => {
  const w = fixture();
  const quote = "Use SQLite.";
  // The exact request may be beyond the normal source excerpt window.
  db.prepare("UPDATE messages SET content=? WHERE id=?").run(
    "Context ".repeat(600) + quote,
    w.prompt,
  );
  const summary = {
    title: "Use SQLite",
    update: "Ready for review.",
    stage: "needs_review",
    request: { ref: "msg_" + w.prompt, quote },
  };
  w.publish({
    ...w.output,
    headline: { ...w.output.headline, update: "Review the storage change." },
    items: [{ ...w.output.items[0], summary }],
  });
  const page = (await w.get()).data;
  expect(page.state[0].summary).toEqual(summary);
  expect(page.headline.update).toBe("Review the storage change.");
  expect(page.sources[summary.request.ref]).toMatchObject({
    owner_message: true,
    verified_quotes: [quote],
  });
  const target = "/evidence?item=" + page.state[0].id;
  const evidence = (await w.request(target)).data;
  expect(evidence.summary).toEqual(summary);
  expect(evidence.sources[summary.request.ref].message).toBe(w.prompt);
  db.prepare(
    "UPDATE messages SET content='A different request.' WHERE id=?",
  ).run(w.prompt);
  const changed = (await w.request(target)).data;
  expect(changed.sources[summary.request.ref].verified_quotes).toBeUndefined();
});
