import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Run } from "../src/server/queue";
import { LOOP_REPOSITORY, type BuildStamp } from "../src/shared/build";

const dir = mkdtempSync(join(tmpdir(), "loop-brief-tool-"));
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
const { db, id } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { nativeBindings, invokeNative } =
  await import("../src/server/native-tools");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { withTestAdapter } = await import("../src/server/providers");
const { applyOutput } = await import("../src/server/briefs/apply");
const { addDecision, editItem } = await import("../src/server/briefs/owner");
const { ledger, readState } = await import("../src/server/briefs/store");
const { serveBrief } = await import("../src/server/briefs/serve");
const { observeProcess } = await import("../src/server/deployments");
const { NativeToolBridge } = await import("../src/server/native-tool-bridge");
const { nativeSessions } = await import("../src/server/native-sessions");

afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(owner = id(), published = true) {
  const project = id(),
    connection = id(),
    agent = id(),
    conversation = id();
  const sourceRun = id(),
    prompt = id(),
    artifact = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Brief project',0)",
  ).run(project, owner);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected','[{\"id\":\"fixture\"}]',0)",
  ).run(connection, owner, seal("fixture-only-secret", owner));
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,folder_id,created_at) VALUES(?,?,?,?,'openai',?,'fixture',?,0)",
  ).run(agent, owner, agent, agent, connection, project);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Design',?,0)",
  ).run(conversation, owner, agent, project);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Use SQLite.','completed',?,?,1,2)",
  ).run(
    sourceRun,
    owner,
    agent,
    conversation,
    sourceRun,
    JSON.stringify({ folderId: project }),
  );
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user','Use SQLite.',1)",
  ).run(prompt, owner, conversation, sourceRun);
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,'Storage','markdown','SQLite is implemented.',2,2)",
  ).run(artifact, owner, agent, conversation, sourceRun);
  if (published) {
    const resultCite = [
      { ref: "res_" + artifact, quote: "SQLite is implemented." },
    ];
    const applied = applyOutput(
      owner,
      project,
      {
        headline: { text: "Storage is ready", cite: resultCite },
        items: [
          { kind: "state", text: "SQLite is implemented", cite: resultCite },
          {
            kind: "decision",
            text: "Use SQLite",
            evidence: "owner_message",
            decided_by: "you",
            cite: [{ ref: "msg_" + prompt }],
          },
          {
            kind: "question",
            text: "Should we add backups?",
            asked_by: agent,
            cite: resultCite,
          },
          {
            kind: "unfinished",
            text: "Add backups",
            next: "Choose a schedule",
            thread: conversation,
            cite: resultCite,
          },
        ],
      },
      {
        builtOnVersion: 0,
        ownerEditRev: 0,
        basisThrough: (
          db
            .prepare(
              "SELECT max(seq) seq FROM project_changes WHERE owner_id=? AND project_id=?",
            )
            .get(owner, project) as { seq: number }
        ).seq,
      },
    );
    expect(applied.outcome).toBe("published");
  }
  const submitted = submit(owner, {
    agentId: agent,
    conversationId: conversation,
    input: "Read the current project",
    idempotencyKey: id(),
  });
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(submitted.id);
  const run = db
    .prepare("SELECT * FROM runs WHERE id=?")
    .get(submitted.id) as Run;
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,enabled) VALUES(?,?,1) ON CONFLICT(owner_id,project_id) DO UPDATE SET enabled=1",
  ).run(owner, project);
  const enable = (enabled: boolean) =>
    db
      .prepare(
        "UPDATE brief_state SET enabled=? WHERE owner_id=? AND project_id=?",
      )
      .run(Number(enabled), owner, project);
  const decision = (text: string, extra = {}) =>
    addDecision(owner, project, {
      kind: "decision",
      text,
      cite: [{ ref: "msg_" + prompt }],
      ...extra,
    });
  return {
    owner,
    project,
    connection,
    agent,
    conversation,
    run,
    prompt,
    artifact,
    enable,
    decision,
  };
}

function binding(run: Run) {
  return nativeBindings(run).find((b) => b.tool === "loop_brief")!;
}
async function read(run: Run, args: Record<string, unknown> = {}, call = id()) {
  const response = await invokeNative(run, binding(run), call, args);
  expect(response).not.toHaveProperty("pending");
  if (!("result" in response))
    throw new Error("Read unexpectedly needs approval");
  expect(response.artifactId).toBe("");
  if (response.result.isError) throw new Error(response.result.content[0].text);
  expect(response.result.isError).toBeUndefined();
  const text = response.result.content[0].text as string;
  return { text, brief: JSON.parse(text) };
}
function refused(
  response: Awaited<ReturnType<typeof invokeNative>>,
  message: RegExp,
) {
  expect(response).toMatchObject({ artifactId: "", result: { isError: true } });
  if (!("result" in response))
    throw new Error("Read unexpectedly needs approval");
  expect(response.result.content[0].text).toMatch(message);
}

it("advertises loop_brief only for an enabled project, for native and API bindings", async () => {
  const w = fixture();
  const offered = binding(w.run);
  expect(offered.description).toContain(
    "Decisions marked with evidence were chosen",
  );
  expect(offered.description).toContain(
    "triggers nothing and needs no approval",
  );
  expect(offered.inputSchema).toMatchObject({
    type: "object",
    properties: { includeIndex: { type: "boolean" } },
  });
  expect(
    nativeBindings(w.run, { plans: true }).find((b) => b.tool === "loop_brief"),
  ).toEqual(offered);
  w.enable(false);
  expect(binding(w.run)).toBeUndefined();
  refused(await invokeNative(w.run, offered, id(), {}), /not enabled/);
  w.enable(true);
  expect(binding(w.run)).toEqual(offered);
  expect(
    nativeBindings({
      ...w.run,
      payload: JSON.stringify({ ...JSON.parse(w.run.payload), reviewId: id() }),
    }).map((b) => b.tool),
  ).toEqual(["loop_review_read"]);
});

it("returns the served brief without owner read markers and leaves project state untouched", async () => {
  const w = fixture();
  w.decision("Owner wording stays pinned");
  db.prepare(
    "UPDATE brief_state SET due_at=12345,generation_id='in-flight',lease_until=999999,goal='Keep it small' WHERE owner_id=? AND project_id=?",
  ).run(w.owner, w.project);
  const snapshot = () =>
    Object.fromEntries(
      [
        "brief_state",
        "brief_items",
        "project_briefs",
        "brief_acks",
        "project_changes",
        "approvals",
        "runs",
      ].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table} WHERE owner_id=? ORDER BY rowid`)
          .all(w.owner),
      ]),
    );
  const before = snapshot();
  const { changes, pins, acknowledged_version, ...expected } = serveBrief(
    w.owner,
    w.project,
  );
  const result = await read(w.run);
  expect(result.brief).toEqual(expected);
  for (const name of [
    "changes",
    "pins",
    "acknowledged_version",
    "index",
    "truncated",
  ])
    expect(result.brief).not.toHaveProperty(name);
  expect(result.text).not.toContain("fixture-only-secret");
  expect(snapshot()).toEqual(before);
});

it("isolates owners and requires explicit target projects to be enabled", async () => {
  const w = fixture(),
    other = fixture(),
    sibling = fixture(w.owner);
  other.decision("Foreign private decision");
  expect((await read(w.run)).text).not.toContain("Foreign private decision");
  await expect(
    read(w.run, { projectId: other.project, includeIndex: true }),
  ).rejects.toThrow(/not found/i);
  expect(
    (await read(w.run, { projectId: sibling.project })).brief.project,
  ).toBe(sibling.project);
  sibling.enable(false);
  await expect(read(w.run, { projectId: sibling.project })).rejects.toThrow(
    /not enabled/,
  );
  const folder = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'folder','Ordinary folder',0)",
  ).run(folder, w.owner);
  await expect(read(w.run, { projectId: folder })).rejects.toThrow(
    /Project not found/,
  );
});

it("prefers conversation filing, falls back to this run, and resolves owned subfolders", async () => {
  const w = fixture(),
    sibling = fixture(w.owner);
  const payload = { ...JSON.parse(w.run.payload), folderId: sibling.project };
  const fallbackRun = { ...w.run, payload: JSON.stringify(payload) };
  expect((await read(fallbackRun)).brief.project).toBe(w.project);
  db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
    w.conversation,
  );
  expect((await read(fallbackRun)).brief.project).toBe(sibling.project);
  // A newer run's payload must not choose the older run's fallback.
  const newer = id();
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Newer task','completed',?,?,?,?)",
  ).run(
    newer,
    w.owner,
    w.agent,
    w.conversation,
    newer,
    JSON.stringify(payload),
    Date.now() + 1000,
    Date.now() + 1000,
  );
  expect((await read(w.run)).brief.project).toBe(w.project);
  const child = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Child',0)",
  ).run(child, w.owner, sibling.project);
  expect(
    (
      await read({
        ...w.run,
        payload: JSON.stringify({ ...payload, folderId: child }),
      })
    ).brief.project,
  ).toBe(sibling.project);
  db.prepare("UPDATE folders SET kind='project' WHERE id=?").run(child);
  expect(
    binding({
      ...w.run,
      payload: JSON.stringify({ ...payload, folderId: child }),
    }),
  ).toBeUndefined();
});

it("refuses runs with no project or a foreign conversation instead of silently falling back", async () => {
  const w = fixture(),
    other = fixture(),
    offered = binding(w.run);
  db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
    w.conversation,
  );
  const unscoped = {
    ...w.run,
    payload: JSON.stringify({ ...JSON.parse(w.run.payload), folderId: null }),
  };
  expect(binding(unscoped)).toBeUndefined();
  refused(
    await invokeNative(unscoped, offered, id(), {}),
    /run has no project/,
  );
  const foreign = { ...w.run, conversation_id: other.conversation };
  expect(binding(foreign)).toBeUndefined();
  refused(await invokeNative(foreign, offered, id(), {}), /run has no project/);
});

it("refuses an enabled project with no published brief without creating one", async () => {
  const w = fixture(id(), false),
    before = readState(w.owner, w.project);
  expect(binding(w.run)).toBeDefined();
  await expect(read(w.run)).rejects.toThrow(
    /no brief yet.*does not start generation/,
  );
  expect(readState(w.owner, w.project)).toEqual(before);
  expect(
    db
      .prepare("SELECT count(*) n FROM project_briefs WHERE project_id=?")
      .get(w.project),
  ).toEqual({ n: 0 });
});

it("returns all active items outside the view in the optional index, including on a section read", async () => {
  const w = fixture();
  for (let n = 0; n < 25; n++)
    w.decision(`Decision ${n}: ` + "界🙂".repeat(65));
  const retired = w.decision("Superseded choice");
  editItem(w.owner, w.project, retired, { status: "superseded" });
  const { brief } = await read(w.run, { section: "state", includeIndex: true });
  expect(brief.state).toHaveLength(1);
  for (const name of ["decisions", "open_questions", "unfinished"])
    expect(brief).not.toHaveProperty(name);
  const served = serveBrief(w.owner, w.project);
  const visible = new Set(
    [served.state, served.decisions, served.open_questions, served.unfinished]
      .flat()
      .map((i) => i.id),
  );
  const hidden = ledger(w.owner, w.project).filter(
    (i) => i.status === "active" && !visible.has(i.id),
  );
  expect(brief.index).toEqual(
    hidden.map(({ id, kind, status, text }) => ({
      id,
      kind,
      status,
      text: Array.from(text).slice(0, 120).join(""),
    })),
  );
  expect(brief.index).toHaveLength(6);
  expect(brief.index.some((i: any) => i.id === retired)).toBe(false);
  expect(brief.truncated).toBeUndefined();
});

it("bounds UTF-8 JSON to 16 KB without cutting retained evidence or citations", async () => {
  const w = fixture();
  const quote = "界".repeat(300);
  db.prepare("UPDATE messages SET content=? WHERE id=?").run(quote, w.prompt);
  for (let n = 0; n < 24; n++)
    w.decision(`${n}:` + "界".repeat(230), {
      why: "界".repeat(240),
      cite: [{ ref: "msg_" + w.prompt, quote }],
    });
  const { text, brief } = await read(w.run, { includeIndex: true });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
  expect(brief.truncated).toBe(true);
  expect(brief.notice).toMatch(/Trimmed to 16 KB/);
  expect(brief.decisions.length).toBeGreaterThan(0);
  expect(brief.decisions.length).toBeLessThan(20);
  for (const item of brief.decisions) {
    expect(item.evidence).toBe("owner_message");
    expect(item.cite).toEqual([{ ref: "msg_" + w.prompt, quote }]);
    expect(item.why).toBe("界".repeat(240));
  }
  expect(text).not.toContain("�");
});

it("bounds oversized indexes and headline citations with explicit omissions", async () => {
  const w = fixture();
  for (let n = 0; n < 90; n++) w.decision(`${n}:` + "界".repeat(230));
  const indexed = await read(w.run, { section: "state", includeIndex: true });
  expect(indexed.brief.index.length).toBeLessThan(71);
  expect(indexed.brief.index.length).toBeGreaterThan(0);
  expect(indexed.brief.truncated).toBe(true);
  expect(Buffer.byteLength(indexed.text)).toBeLessThanOrEqual(16 * 1024);
  const version = readState(w.owner, w.project).current_version;
  const row = db
    .prepare(
      "SELECT view FROM project_briefs WHERE owner_id=? AND project_id=? AND version=?",
    )
    .get(w.owner, w.project, version) as { view: string };
  const view = JSON.parse(row.view);
  view.headline = {
    text: "Storage",
    cite: Array.from({ length: 500 }, () => ({
      ref: "res_" + w.artifact,
      quote: "SQLite is implemented.",
    })),
  };
  db.prepare(
    "UPDATE project_briefs SET view=? WHERE owner_id=? AND project_id=? AND version=?",
  ).run(JSON.stringify(view), w.owner, w.project, version);
  const result = await read(w.run);
  expect(result.brief.truncated).toBe(true);
  expect(result.brief.headline).toBeNull();
  expect(result.brief.decisions.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16 * 1024);
});

it.each([
  ["multibyte titles", "界"],
  ["escaped controls", "\u001b"],
  ["escaped surrogates", "\ud800"],
])(
  "keeps all live deployment comparisons when trimming historical prose (%s)",
  async (_label, character) => {
    const w = fixture();
    for (let n = 0; n < 24; n++)
      w.decision(`${n}:` + "界".repeat(230), { why: "界".repeat(240) });
    db.prepare("UPDATE conversations SET title=? WHERE id=?").run(
      character.repeat(200),
      w.conversation,
    );
    db.prepare(
      "UPDATE brief_state SET goal=? WHERE owner_id=? AND project_id=?",
    ).run("\u001b".repeat(200), w.owner, w.project);
    const commit = "a".repeat(40),
      at = Date.now();
    for (let n = 0; n < 10; n++) {
      const run = id(),
        checkout = id();
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Build change','completed',?,'{}',?,?)",
      ).run(run, w.owner, w.agent, w.conversation, run, at + n, at + n);
      db.prepare(
        "INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state,end_head,ended_at) VALUES(?,?,?,?,?,'fixture','fixture','main',?,0,0,?,'captured',?,?)",
      ).run(
        checkout,
        w.owner,
        run,
        w.agent,
        w.conversation,
        commit,
        at + n,
        commit,
        at + n,
      );
      db.prepare("INSERT INTO checkout_build_targets VALUES(?,?,?,?,?,?)").run(
        checkout,
        w.owner,
        run,
        LOOP_REPOSITORY,
        commit,
        JSON.stringify([commit]),
      );
    }
    const build: BuildStamp = {
      id: id(),
      repository: LOOP_REPOSITORY,
      commit,
      clean: true,
      builtAt: at,
      ancestors: [commit],
    };
    const stopApi = observeProcess("api", build),
      stopWorker = observeProcess("worker", build);
    try {
      const expected = serveBrief(w.owner, w.project).deployments!;
      expect(expected).toHaveLength(10);
      expect(
        expected.every((item) => item.current && item.status === "included"),
      ).toBe(true);
      const result = await read(w.run, { includeIndex: true });
      expect(result.brief.truncated).toBe(true);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16 * 1024);
      expect(result.brief.deployments).toEqual(
        expected.map((item) => ({ ...item, checkedAt: expect.any(Number) })),
      );
    } finally {
      stopApi();
      stopWorker();
    }
  },
);

it("rechecks project access before returning a previous tool receipt", async () => {
  const w = fixture(),
    sibling = fixture(w.owner),
    call = id(),
    offered = binding(w.run);
  const args = { projectId: sibling.project };
  const first = await read(w.run, args, call);
  expect(await read(w.run, args, call)).toEqual(first);
  sibling.enable(false);
  refused(await invokeNative(w.run, offered, call, args), /not enabled/);
  sibling.enable(true);
  w.enable(false);
  refused(await invokeNative(w.run, offered, call, args), /not enabled/);
});

it("binds a default project's receipt to its original target across refiling", async () => {
  const w = fixture(),
    sibling = fixture(w.owner),
    call = id(),
    offered = binding(w.run);
  expect((await read(w.run, {}, call)).brief.project).toBe(w.project);
  expect(
    JSON.parse(
      (
        db
          .prepare(
            "SELECT arguments FROM native_calls WHERE run_id=? AND call_id=?",
          )
          .get(w.run.id, call) as { arguments: string }
      ).arguments,
    ).projectId,
  ).toBe(w.project);
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    sibling.project,
    w.conversation,
  );
  w.enable(false);
  refused(
    await invokeNative(w.run, offered, call, {}),
    /project or inputs changed/,
  );
  expect((await read(w.run)).brief.project).toBe(sibling.project);
});

it("validates tool input at the production invocation boundary", async () => {
  const w = fixture();
  for (const args of [
    { section: "secrets" },
    { includeIndex: "yes" },
    { projectId: "" },
    { generate: true },
  ])
    await expect(read(w.run, args)).rejects.toThrow();
});

it("API-provider runs discover and call the same read-only tool without approval", async () => {
  const w = fixture();
  let received: any;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      expect(input.tools?.find((t) => t.name === "loop_brief")).toBeDefined();
      const result = input.messages.find((m) => m.role === "tool");
      if (!result)
        yield {
          toolCall: {
            id: "read-brief",
            name: "loop_brief",
            arguments: { includeIndex: true },
          },
        };
      else {
        const response = JSON.parse(result.content);
        received = JSON.parse(response.content[0].text);
        yield { text: "Picked up the verified project state." };
      }
    },
  });
  try {
    expect(await executeAgent(w.run)).toBe(true);
  } finally {
    restore();
  }
  expect(received).toMatchObject({ project: w.project, version: 1, index: [] });
  expect(received.decisions[0].evidence).toBe("owner_message");
  expect(
    db
      .prepare("SELECT count(*) n FROM approvals WHERE owner_id=?")
      .get(w.owner),
  ).toEqual({ n: 0 });
  expect(
    db
      .prepare("SELECT count(*) n FROM brief_acks WHERE owner_id=?")
      .get(w.owner),
  ).toEqual({ n: 0 });
});

it("API-provider runs receive a recoverable refusal before the first brief publication", async () => {
  const w = fixture(id(), false);
  let rounds = 0;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_secret, input) {
      rounds++;
      const response = input.messages.find(
        (message) => message.role === "tool",
      );
      if (!response) {
        yield {
          toolCall: { id: "not-ready", name: "loop_brief", arguments: {} },
        };
      } else {
        const result = JSON.parse(response.content);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(
          /no brief yet.*does not start generation/,
        );
        yield { text: "I can continue while the first brief is pending." };
      }
    },
  });
  try {
    expect(await executeAgent(w.run)).toBe(true);
  } finally {
    restore();
  }
  expect(rounds).toBe(2);
  expect(readState(w.owner, w.project).current_version).toBe(0);
  expect(
    db
      .prepare("SELECT count(*) n FROM project_briefs WHERE project_id=?")
      .get(w.project),
  ).toEqual({ n: 0 });
});

it("the private native bridge rechecks cached reads after revocation, refiling and deletion", async () => {
  const w = fixture(),
    sibling = fixture(w.owner);
  const live = { run: w.run, bootstrapRun: w.run, bridgeWaiting: 0 };
  const current = vi
    .spyOn(nativeSessions, "current")
    .mockReturnValue(live as any);
  const bridge = new NativeToolBridge();
  await bridge.start();
  const ticket = bridge.issue(w.conversation, "fixture-generation");
  const request = async (body: unknown) => {
    const response = await fetch(ticket.url + "/pi", {
      method: "POST",
      headers: {
        authorization: "Bearer " + ticket.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    const tools = await request({ method: "tools/list" });
    expect(tools.tools.map((t: any) => t.name)).toContain("loop_brief");
    const readRequest = {
      method: "tools/call",
      id: "read",
      name: "loop_brief",
      arguments: { section: "decisions" },
    };
    const result = await request(readRequest);
    expect(JSON.parse(result.content[0].text).decisions[0].evidence).toBe(
      "owner_message",
    );
    expect(await request(readRequest)).toEqual(result);
    w.enable(false);
    for (const call of [readRequest, { ...readRequest, id: "revoked" }]) {
      const denied = await request(call);
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/not enabled/);
    }
    db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
      sibling.project,
      w.conversation,
    );
    const refiled = await request(readRequest);
    expect(refiled.isError).toBe(true);
    expect(refiled.content[0].text).toMatch(/project or inputs changed/);
    const fresh = await request({ ...readRequest, id: "new-project" });
    expect(JSON.parse(fresh.content[0].text).project).toBe(sibling.project);
    w.enable(true);
    db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
      w.project,
      w.conversation,
    );
    const explicit = {
      ...readRequest,
      id: "explicit",
      arguments: { projectId: sibling.project },
    };
    expect(JSON.parse((await request(explicit)).content[0].text).project).toBe(
      sibling.project,
    );
    db.transaction(() => {
      db.prepare("UPDATE agents SET folder_id=NULL WHERE id=?").run(
        sibling.agent,
      );
      db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
        sibling.conversation,
      );
      db.prepare("DELETE FROM folders WHERE id=?").run(sibling.project);
    })();
    const deleted = await request(explicit);
    expect(deleted.isError).toBe(true);
    expect(deleted.content[0].text).toMatch(/not found/i);
  } finally {
    await bridge.close();
    current.mockRestore();
  }
});
