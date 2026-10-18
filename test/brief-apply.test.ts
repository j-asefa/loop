import { afterAll, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
vi.mock("../src/server/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { readdirSync, readFileSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync("migrations/" + file, "utf8"));
  return {
    db,
    id: randomUUID,
    now: () => Date.now(),
    emit: (owner: string, run: string, type: string, payload: unknown) =>
      db
        .prepare(
          "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,?,?,?)",
        )
        .run(owner, run, type, JSON.stringify(payload), Date.now()),
  };
});
const { db, id, now } = await import("../src/server/db");
const { applyOutput } = await import("../src/server/briefs/apply");
const { serveBrief } = await import("../src/server/briefs/serve");
const { ledger, readState } = await import("../src/server/briefs/store");
const { resolveCite, checkQuote } = await import("../src/server/briefs/cites");
const { Output, Brief, outputJsonSchema } =
  await import("../src/server/briefs/schema");
afterAll(() => db.close());

function fixture(owner = id()) {
  const project = id(),
    connection = id(),
    agent = id(),
    threads = [id(), id()],
    runs = [id(), id()],
    messages = [id(), id()],
    artifacts = [id(), id()],
    approval = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Brief project',0)",
  ).run(project, owner);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture','','connected','[]',0)",
  ).run(connection, owner);
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'openai',?,'fixture',0)",
  ).run(agent, owner, agent, agent, connection);
  for (let i = 0; i < 2; i++) {
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Thread',?,0)",
    ).run(threads[i], owner, agent, project);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Work','completed',?,?,?,?)",
    ).run(
      runs[i],
      owner,
      agent,
      threads[i],
      runs[i],
      JSON.stringify({ folderId: project }),
      10 + i * 100,
      20 + i * 100,
    );
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user','Use the verified design.','{}',?)",
    ).run(messages[i], owner, threads[i], runs[i], 30 + i * 100);
    db.prepare(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,pinned,created_at,updated_at) VALUES(?,?,?,?,?,'Answer','markdown','The verified design is applied.',?,?,?,?)",
    ).run(
      artifacts[i],
      owner,
      agent,
      threads[i],
      runs[i],
      JSON.stringify({ messageId: messages[i] }),
      i === 0 ? 1 : 0,
      40 + i * 100,
      40 + i * 100,
    );
    // Historical publication rows preserve the stored result timestamp.
    db.prepare(
      "UPDATE project_changes SET at=? WHERE owner_id=? AND kind='result' AND ref=?",
    ).run(40 + i * 100, owner, artifacts[i]);
  }
  db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,'approved',NULL,?,?)").run(
    approval,
    owner,
    runs[0],
    id(),
    '{"tool":"apply design"}',
    now(),
    now() + 100_000,
  );
  const cite = [{ ref: "res_" + artifacts[0], quote: "verified design" }];
  const headline = { text: "Verified project", cite };
  const output = (items: unknown[]) => ({ headline, items });
  const apply = (items: unknown[], overrides: Record<string, number> = {}) => {
    const s = readState(owner, project);
    const through = Number(
      db
        .prepare(
          "INSERT INTO project_changes(owner_id,project_id,kind,ref,at) VALUES(?,?,'prompt',?,?)",
        )
        .run(owner, project, messages[0], now()).lastInsertRowid,
    );
    return applyOutput(owner, project, output(items), {
      builtOnVersion: s.current_version,
      ownerEditRev: s.owner_edit_rev,
      basisThrough: through,
      ...overrides,
    });
  };
  const state = (text = "Project has a verified design") => ({
    kind: "state",
    text,
    cite,
  });
  return {
    owner,
    project,
    agent,
    threads,
    runs,
    messages,
    artifacts,
    approval,
    cite,
    headline,
    output,
    apply,
    state,
    read: () => serveBrief(owner, project),
    items: () => ledger(owner, project),
  };
}

it("exports bounded zod and serializable tool schemas", () => {
  const w = fixture();
  expect(Output.safeParse(w.output([w.state()])).success).toBe(true);
  expect(Output.safeParse(w.output([w.state("x".repeat(241))])).success).toBe(
    false,
  );
  expect(
    JSON.parse(JSON.stringify(outputJsonSchema)).properties.items,
  ).toBeTruthy();
  expect(Brief.safeParse(w.read()).success).toBe(true);
  expect(
    db.prepare("SELECT 1 FROM brief_state WHERE project_id=?").get(w.project),
  ).toBeUndefined();
});

it("drops a new unresolved citation and reports cite_unresolved", () => {
  const w = fixture();
  expect(
    w.apply([{ ...w.state(), cite: [{ ref: "res_missing" }] }]),
  ).toMatchObject({
    outcome: "failed",
    errors: [expect.objectContaining({ code: "cite_unresolved" })],
  });
  expect(w.items()).toEqual([]);
  expect(w.read().version).toBe(0);
});
it("keeps the last good existing item and flags unresolved citations", () => {
  const w = fixture();
  w.apply([w.state()]);
  const item = w.items()[0];
  expect(
    w.apply([
      {
        ...w.state("Fabricated replacement"),
        id: item.id,
        cite: [{ ref: "msg_missing" }],
      },
    ]).outcome,
  ).toBe("published");
  expect(w.items()[0]).toMatchObject({
    id: item.id,
    text: item.text,
    cite_stale: true,
  });
});
it("drops a new uncontained quote and flags an existing item without changing its text", () => {
  const w = fixture();
  const bad = {
    ...w.state(),
    cite: [{ ref: "res_" + w.artifacts[0], quote: "invented quotation" }],
  };
  expect(w.apply([bad])).toMatchObject({
    outcome: "failed",
    errors: [expect.objectContaining({ code: "quote_not_contained" })],
  });
  w.apply([w.state()]);
  const item = w.items()[0];
  w.apply([{ ...bad, id: item.id, text: "Changed" }]);
  expect(w.items()[0]).toMatchObject({ text: item.text, cite_stale: true });
  expect(checkQuote("A real quote here", "  real quote  ")).toBe(true);
  expect(checkQuote("A real quote here", "Real quote")).toBe(false);
});
it("rejects owner-message evidence citing an assistant artifact", () => {
  const w = fixture();
  expect(
    w.apply([
      {
        kind: "decision",
        text: "Use this design",
        cite: w.cite,
        evidence: "owner_message",
        decided_by: "you",
      },
    ]),
  ).toMatchObject({
    outcome: "failed",
    errors: [expect.objectContaining({ code: "evidence_mismatch" })],
  });
});
it("rewrites a decision without evidence as a question from its proposing agent", () => {
  const w = fixture();
  expect(
    w.apply([
      {
        kind: "decision",
        text: "Use this design?",
        cite: w.cite,
        decided_by: "you",
      },
    ]),
  ).toMatchObject({
    outcome: "published",
    errors: [expect.objectContaining({ code: "decision_without_evidence" })],
  });
  expect(w.items()[0]).toMatchObject({
    kind: "question",
    asked_by: w.agent,
    status: "open",
  });
  expect(w.items()[0].id).toMatch(/^q_/);
});
it("answers a pinned question while preserving words and flagging the lifecycle change", () => {
  const w = fixture();
  w.apply([
    { kind: "question", text: "Which design?", cite: w.cite, asked_by: "you" },
  ]);
  const item = w.items()[0];
  db.prepare("UPDATE brief_items SET pinned=1 WHERE id=?").run(item.id);
  db.prepare("INSERT INTO brief_acks VALUES(?,?,1,?)").run(
    w.owner,
    w.project,
    now(),
  );
  const result = w.apply([
    {
      id: item.id,
      kind: "question",
      text: "Reworded",
      cite: w.cite,
      asked_by: w.agent,
      status: "answered",
      answered_cite: { ref: "msg_" + w.messages[1] },
    },
  ]);
  expect(result).toMatchObject({
    outcome: "published",
    errors: expect.arrayContaining([
      expect.objectContaining({ code: "pinned_text_changed" }),
    ]),
  });
  expect(w.items()[0]).toMatchObject({
    text: "Which design?",
    asked_by: "you",
    status: "answered",
    pinned: true,
  });
  expect(w.read().changes).toContainEqual({
    op: "resolved",
    field: "open_questions",
    id: item.id,
    since_version: 2,
    pinned: true,
  });
});
it("keeps all 21 decisions in the ledger and selects 20 with overflow", () => {
  const w = fixture();
  w.apply(
    Array.from({ length: 21 }, (_, i) => ({
      kind: "decision",
      text: "Choice " + i,
      cite: [{ ref: "msg_" + w.messages[0] }],
      evidence: "owner_message",
      decided_by: "you",
    })),
  );
  expect(w.items()).toHaveLength(21);
  expect(w.read().decisions).toHaveLength(20);
  expect(w.read().overflow.decisions).toBe(1);
  const omitted = w
    .items()
    .find((i) => !w.read().decisions.some((v) => v.id === i.id))!;
  db.prepare("UPDATE brief_items SET pinned=1 WHERE id=?").run(omitted.id);
  w.apply([w.state("Another project update")]);
  expect(w.items().filter((i) => i.kind === "decision")).toHaveLength(21);
  expect(w.read().decisions[0].id).toBe(omitted.id);
});
it("discards an obsolete base version without any writes", () => {
  const w = fixture();
  w.apply([w.state()]);
  const before = db.serialize();
  expect(
    applyOutput(w.owner, w.project, w.output([w.state("New")]), {
      builtOnVersion: 0,
      ownerEditRev: 0,
      basisThrough: 999999,
    }),
  ).toMatchObject({ outcome: "discarded" });
  expect(db.serialize().equals(before)).toBe(true);
});
it("discards an obsolete owner revision without any writes", () => {
  const w = fixture();
  w.apply([w.state()]);
  db.prepare("UPDATE brief_state SET owner_edit_rev=1 WHERE project_id=?").run(
    w.project,
  );
  const before = db.serialize();
  expect(
    applyOutput(w.owner, w.project, w.output([]), {
      builtOnVersion: 1,
      ownerEditRev: 0,
      basisThrough: 999999,
    }),
  ).toMatchObject({ outcome: "discarded" });
  expect(db.serialize().equals(before)).toBe(true);
});
it("makes a retry of the same basis a duplicate without adding a version", () => {
  const w = fixture();
  w.apply([w.state()]);
  const through = readState(w.owner, w.project).basis_through;
  expect(
    applyOutput(w.owner, w.project, w.output([w.state("Do not append")]), {
      builtOnVersion: 0,
      ownerEditRev: 0,
      basisThrough: through,
    }).outcome,
  ).toBe("duplicate");
  expect(w.read().version).toBe(1);
  expect(w.items()).toHaveLength(1);
});
it("advances the basis without a version when authored content is unchanged", () => {
  const w = fixture();
  w.apply([w.state()]);
  const item = w.items()[0],
    through = readState(w.owner, w.project).basis_through;
  expect(w.apply([{ ...w.state(), id: item.id }]).outcome).toBe("unchanged");
  expect(readState(w.owner, w.project).basis_through).toBeGreaterThan(through);
  expect(w.read().version).toBe(1);
  expect(
    db
      .prepare("SELECT count(*) n FROM project_briefs WHERE project_id=?")
      .get(w.project),
  ).toEqual({ n: 1 });
});
it("accumulates changes from acknowledged version 10 through version 14", () => {
  const w = fixture();
  for (let version = 1; version <= 10; version++) {
    w.headline.text = "Headline " + version;
    w.apply([]);
  }
  db.prepare("INSERT INTO brief_acks VALUES(?,?,10,?)").run(
    w.owner,
    w.project,
    now(),
  );
  w.apply([
    { kind: "question", text: "First change", cite: w.cite, asked_by: "you" },
  ]);
  const first = w.items()[0];
  w.apply([w.state("Second change")]);
  const second = w.items().find((i) => i.kind === "state")!;
  for (const version of [13, 14]) {
    w.headline.text = "Headline " + version;
    w.apply([]);
  }
  expect(w.read()).toMatchObject({
    version: 14,
    acknowledged_version: 10,
    changes: expect.arrayContaining([
      expect.objectContaining({ id: first.id, since_version: 11 }),
      expect.objectContaining({ id: second.id, since_version: 12 }),
    ]),
  });
});
it("shows a new pending approval immediately without generation", () => {
  const w = fixture();
  db.prepare("UPDATE approvals SET state='pending' WHERE id=?").run(w.approval);
  expect(w.read()).toMatchObject({
    version: 0,
    status: "needs_you",
    needs_you: [
      { kind: "approval", ref: w.approval, conversation: w.threads[0] },
    ],
  });
  db.prepare("UPDATE approvals SET state='approved' WHERE id=?").run(
    w.approval,
  );
  expect(w.read().status).toBe("idle");
});
it("scopes citations and ledger ids by owner and nearest project", () => {
  const w = fixture(),
    other = fixture(),
    sibling = fixture(w.owner);
  expect(
    resolveCite(other.owner, w.project, { ref: "res_" + w.artifacts[0] }),
  ).toBeNull();
  expect(
    resolveCite(w.owner, sibling.project, { ref: "msg_" + w.messages[0] }),
  ).toBeNull();
  expect(() => serveBrief(other.owner, w.project)).toThrow();
  sibling.apply([sibling.state()]);
  const foreignId = sibling.items()[0].id;
  expect(w.apply([{ ...w.state(), id: foreignId }])).toMatchObject({
    outcome: "published",
    errors: [expect.objectContaining({ code: "unknown_id" })],
  });
  expect(w.items()[0].id).not.toBe(foreignId);
});
it("revalidates omitted saved citations after unsaving without dropping the ledger row", () => {
  const w = fixture();
  expect(
    resolveCite(w.owner, w.project, { ref: "saved_" + w.messages[0] }),
  ).toMatchObject({
    kind: "saved",
    content: "The verified design is applied.",
  });
  w.apply([
    {
      kind: "decision",
      text: "Keep the design",
      cite: [{ ref: "saved_" + w.messages[0] }],
      evidence: "owner_saved",
      decided_by: "you",
    },
  ]);
  db.prepare("UPDATE artifacts SET pinned=0 WHERE id=?").run(w.artifacts[0]);
  w.apply([]);
  expect(w.items()[0]).toMatchObject({ kind: "decision", cite_stale: true });
});
it("truncates bounded text and ignores model-supplied derived fields", () => {
  const w = fixture();
  const input = {
    ...w.output([
      { ...w.state("x".repeat(500)), pinned: true, author: "owner" },
    ]),
    status: "needs_you",
    goal: { text: "Injected goal" },
  };
  expect(
    applyOutput(w.owner, w.project, input, {
      builtOnVersion: 0,
      ownerEditRev: 0,
      basisThrough: 999999,
    }),
  ).toMatchObject({
    outcome: "published",
    errors: expect.arrayContaining([
      expect.objectContaining({ code: "bound_exceeded" }),
      expect.objectContaining({ code: "derived_field" }),
    ]),
  });
  expect(w.items()[0].text).toHaveLength(240);
  expect(w.items()[0].text.endsWith("…")).toBe(true);
  expect(w.items()[0]).toMatchObject({ author: "model", pinned: false });
  expect(w.read().goal).toBeNull();
});
it("requires approved permission and a later result for applied evidence", () => {
  const w = fixture();
  const decision = {
    kind: "decision",
    text: "Apply the design",
    decided_by: "you",
  };
  expect(
    w.apply([
      {
        ...decision,
        cite: [{ ref: "approval_" + w.approval }],
        evidence: "approval",
      },
    ]).outcome,
  ).toBe("published");
  db.prepare("UPDATE approvals SET state='pending' WHERE id=?").run(w.approval);
  expect(
    w.apply([
      {
        ...decision,
        cite: [{ ref: "approval_" + w.approval }],
        evidence: "approval",
      },
    ]).outcome,
  ).toBe("failed");
  expect(
    w.apply([{ ...decision, cite: w.cite, evidence: "applied" }]).outcome,
  ).toBe("failed");
  db.prepare("UPDATE runs SET created_at=20 WHERE id=?").run(w.runs[1]);
  expect(
    w.apply([
      {
        ...decision,
        cite: [...w.cite, { ref: "res_" + w.artifacts[1] }],
        evidence: "applied",
      },
    ]).outcome,
  ).toBe("failed");
  db.prepare("UPDATE runs SET created_at=110 WHERE id=?").run(w.runs[1]);
  expect(
    w.apply([
      {
        ...decision,
        cite: [...w.cite, { ref: "res_" + w.artifacts[1] }],
        evidence: "applied",
      },
    ]).outcome,
  ).toBe("published");
});
it("retains superseded decisions and rejects cross-project supersedes links", () => {
  const w = fixture(),
    other = fixture(w.owner);
  const decision = {
    kind: "decision",
    text: "First choice",
    cite: [{ ref: "msg_" + w.messages[0] }],
    evidence: "owner_message",
    decided_by: "you",
  };
  w.apply([decision]);
  const first = w.items()[0];
  w.apply([{ ...decision, text: "Replacement", supersedes: first.id }]);
  expect(w.items()).toHaveLength(2);
  expect(w.items().find((i) => i.id === first.id)?.status).toBe("superseded");
  other.apply([other.state()]);
  const target = other.items()[0].id;
  expect(w.apply([{ ...decision, supersedes: target }]).outcome).toBe("failed");
  expect(w.items()).toHaveLength(2);
});
it("derives native questions, working, failures and blockers from current state", () => {
  const w = fixture();
  const nativeId = id();
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
  ).run(w.runs[0]);
  expect(w.read().status).toBe("working");
  db.prepare(
    "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,created_at) VALUES(?,?,?,'generation','request',?,'pending',?)",
  ).run(
    nativeId,
    w.runs[0],
    w.threads[0],
    JSON.stringify({ questions: [{ text: "Which design?" }] }),
    now(),
  );
  expect(w.read()).toMatchObject({
    status: "needs_you",
    needs_you: [
      { kind: "question", ref: nativeId, conversation: w.threads[0] },
    ],
  });
  db.prepare("UPDATE native_decisions SET state='resolved' WHERE id=?").run(
    nativeId,
  );
  w.apply([
    {
      kind: "unfinished",
      thread: w.threads[0],
      text: "Ship",
      next: "Wait",
      blocker: "Needs a release",
      cite: w.cite,
    },
  ]);
  expect(w.read().status).toBe("blocked");
  db.prepare("UPDATE runs SET state='failed' WHERE id=?").run(w.runs[0]);
  expect(w.read().status).toBe("needs_you");
  db.prepare("UPDATE runs SET attention_dismissed_at=? WHERE id=?").run(
    now(),
    w.runs[0],
  );
  expect(w.read().status).toBe("blocked");
});
it.each([undefined, ""])(
  "clears an updated task's old blocker with %s",
  (blocker) => {
    const w = fixture();
    const task = {
      kind: "unfinished",
      thread: w.threads[0],
      text: "Check Send",
      next: "Check Send in the app",
      cite: w.cite,
    };
    w.apply([{ ...task, blocker: "App update pending" }]);
    const item = w.items()[0];
    // Not submitting an item must not erase its obstacle.
    w.apply([w.state()]);
    expect(w.items().find((row) => row.id === item.id)?.blocker).toBe(
      "App update pending",
    );
    expect(
      w.apply([
        { ...task, id: item.id, ...(blocker === undefined ? {} : { blocker }) },
      ]).outcome,
    ).toBe("published");
    expect(w.read().unfinished[0].blocker || "").toBe("");
    expect(w.read().status).toBe("idle");
  },
);

it("preserves a pinned task's blocker when a refresh omits it", async () => {
  const { editItem } = await import("../src/server/briefs/owner");
  const w = fixture();
  const task = {
    kind: "unfinished",
    thread: w.threads[0],
    text: "Check Send",
    next: "Obtain device access",
    cite: w.cite,
  };
  w.apply([{ ...task, blocker: "Device access is unavailable" }]);
  const item = w.items()[0];
  editItem(w.owner, w.project, item.id, { pinned: true });
  w.apply([{ ...task, id: item.id }]);
  expect(w.read().unfinished[0].blocker).toBe("Device access is unavailable");
  expect(w.read().status).toBe("blocked");
});

it("counts synthesis-relevant changes but not creation-only approvals", () => {
  const w = fixture();
  const before = w.read().basis.pending;
  db.prepare(
    "INSERT INTO project_changes(owner_id,project_id,kind,ref,at) VALUES(?,?,'approval_created',?,?)",
  ).run(w.owner, w.project, w.approval, now());
  expect(w.read().basis.pending).toBe(before);
  db.prepare(
    "INSERT INTO project_changes(owner_id,project_id,kind,ref,at) VALUES(?,?,'approval_resolved',?,?)",
  ).run(w.owner, w.project, w.approval, now());
  expect(w.read().basis.pending).toBe(before + 1);
});
it("resolves recorded PR merges without confusing equal PR numbers across repositories", () => {
  const w = fixture();
  const watch = (repo: string) => {
    const watchId = id();
    db.prepare(
      "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,ended_reason,created_at,updated_at) VALUES(?,?,?,?,'owner',?,7,'stopped','Merged',0,0)",
    ).run(watchId, w.owner, w.threads[0], w.agent, repo);
    db.prepare(
      "INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at) VALUES(?,?,'pr_update',?,?,0)",
    ).run(w.owner, w.project, watchId + ":merged:7", w.threads[0]);
  };
  watch("first");
  expect(resolveCite(w.owner, w.project, { ref: "pr_7:c_7" })).toMatchObject({
    kind: "pr",
    merged: true,
  });
  expect(
    w.apply([
      {
        kind: "decision",
        text: "Merged the design",
        cite: [{ ref: "pr_7:c_7" }],
        evidence: "merge",
        decided_by: "you",
      },
    ]).outcome,
  ).toBe("published");
  watch("second");
  expect(resolveCite(w.owner, w.project, { ref: "pr_7:c_7" })).toBeNull();
});

it("deduplicates an unchanged pass using its durable basis cursor", () => {
  const w = fixture();
  w.apply([w.state()]);
  expect(w.apply([]).outcome).toBe("unchanged");
  const state = readState(w.owner, w.project);
  expect(
    applyOutput(
      w.owner,
      w.project,
      w.output([w.state("Do not create another")]),
      {
        builtOnVersion: state.current_version,
        ownerEditRev: state.owner_edit_rev,
        basisThrough: state.basis_through,
      },
    ).outcome,
  ).toBe("duplicate");
  expect(w.items()).toHaveLength(1);
  expect(w.read().version).toBe(1);
});

it("rolls back ledger edits and the cursor when publication fails", () => {
  const w = fixture();
  db.exec(
    `CREATE TRIGGER brief_test_failure BEFORE INSERT ON project_briefs WHEN new.project_id='${w.project}' BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END`,
  );
  try {
    expect(() => w.apply([w.state()])).toThrow("fixture publication failure");
  } finally {
    db.exec("DROP TRIGGER brief_test_failure");
  }
  expect(w.items()).toEqual([]);
  expect(
    db.prepare("SELECT 1 FROM brief_state WHERE project_id=?").get(w.project),
  ).toBeUndefined();
  expect(w.read().version).toBe(0);
});

it("rejects malformed or entirely invalid outputs without advancing the cursor", () => {
  const w = fixture();
  for (const input of [
    "not JSON",
    null,
    w.output([{ kind: "__proto__" }]),
    w.output([{ kind: "constructor" }]),
    {
      headline: { text: "Unsupported", cite: [{ ref: "res_missing" }] },
      items: [],
    },
  ]) {
    expect(
      applyOutput(w.owner, w.project, input, {
        builtOnVersion: 0,
        ownerEditRev: 0,
        basisThrough: 999999,
      }).outcome,
    ).toBe("failed");
  }
  expect(
    db.prepare("SELECT 1 FROM brief_state WHERE project_id=?").get(w.project),
  ).toBeUndefined();
});

it("finds not-sent messages across pages while retaining owner and project isolation", () => {
  const w = fixture(),
    other = fixture(w.owner);
  const failed = (project: string | null, created: number, chosen = 1) => {
    const sendId = id();
    db.prepare(
      "INSERT INTO scheduled_sends(id,owner_id,agent_id,folder_id,folder_chosen,input,idempotency_key,send_at,state,created_at) VALUES(?,?,?,?,?,'Scheduled work',?,?,'failed',?)",
    ).run(sendId, w.owner, w.agent, project, chosen, sendId, created, created);
    return sendId;
  };
  const target = failed(w.project, 1);
  for (let i = 0; i < 101; i++) failed(other.project, i + 10);
  expect(w.read()).toMatchObject({
    status: "needs_you",
    needs_you: [{ kind: "not_sent", ref: target, conversation: "" }],
  });
  db.prepare("UPDATE scheduled_sends SET state='cancelled' WHERE id=?").run(
    target,
  );
  db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(
    w.project,
    w.agent,
  );
  const defaulted = failed(null, 2, 0);
  failed(null, 3, 1); // Explicitly unscoped must not inherit the agent's project.
  expect(w.read().needs_you.map((i) => i.ref)).toEqual([defaulted]);
});

it("shows owner-review attention only for a matching recorded PR request", () => {
  const w = fixture(),
    watchId = id();
  db.prepare(
    "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,login,head_sha,created_at,updated_at) VALUES(?,?,?,?,'org','repo',7,'watching','reviewer','abcdef',0,0)",
  ).run(watchId, w.owner, w.threads[0], w.agent);
  const card = {
    type: "github_pull_requests",
    tool: "pull_request_read",
    fetchedAt: now(),
    pulls: [
      {
        owner: "org",
        repo: "repo",
        number: 7,
        state: "open",
        headSha: "abcdef",
        reviewers: ["reviewer"],
      },
    ],
  };
  db.prepare("UPDATE artifacts SET kind='github_pr',content=? WHERE id=?").run(
    JSON.stringify(card),
    w.artifacts[0],
  );
  expect(w.read()).toMatchObject({
    version: 0,
    status: "needs_you",
    needs_you: [{ kind: "review", ref: watchId, conversation: w.threads[0] }],
  });
  db.prepare("UPDATE pr_watches SET head_sha='new-head' WHERE id=?").run(
    watchId,
  );
  expect(w.read().needs_you).toEqual([]);
  db.prepare("UPDATE artifacts SET content=? WHERE id=?").run(
    '{"type":"github_pull_requests","pulls":[null,{"number":7,"owner":9}]}',
    w.artifacts[0],
  );
  expect(w.read().needs_you).toEqual([]);
  db.prepare("UPDATE artifacts SET content='null' WHERE id=?").run(
    w.artifacts[0],
  );
  expect(w.read().needs_you).toEqual([]);
  db.prepare(
    "UPDATE pr_watches SET state='stopped',ended_reason='Merged' WHERE id=?",
  ).run(watchId);
  expect(w.read().artifacts).toContainEqual({
    kind: "pr",
    ref: watchId,
    state: "merged",
  });
});

it("keeps nested project attention separate and reads beyond the Feed page size", () => {
  const w = fixture(),
    nested = fixture(w.owner);
  db.prepare("UPDATE folders SET parent_id=? WHERE id=?").run(
    w.project,
    nested.project,
  );
  db.prepare("UPDATE approvals SET state='pending' WHERE id=?").run(
    nested.approval,
  );
  expect(nested.read().status).toBe("needs_you");
  expect(w.read().status).toBe("idle");
  for (let i = 0; i < 42; i++) {
    const thread = id(),
      run = id();
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Earlier thread',?,?)",
    ).run(thread, w.owner, w.agent, w.project, now() + i);
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Earlier work','completed',?,?,?)",
    ).run(run, w.owner, w.agent, thread, run, now() + i, now() + i);
  }
  db.prepare("UPDATE approvals SET state='pending' WHERE id=?").run(w.approval);
  expect(w.read().needs_you).toContainEqual({
    kind: "approval",
    ref: w.approval,
    conversation: w.threads[0],
  });
});

it("does not mistake an automated prompt for an owner decision", () => {
  const w = fixture();
  db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(
    '{"automation":{"kind":"github_watch"}}',
    w.messages[0],
  );
  expect(
    w.apply([
      {
        kind: "decision",
        text: "Automated advice",
        cite: [{ ref: "msg_" + w.messages[0] }],
        evidence: "owner_message",
        decided_by: "you",
      },
    ]).outcome,
  ).toBe("failed");
});

it("rejects actual delegated prompts and workflow child prompts as owner evidence", async () => {
  const w = fixture(),
    worker = fixture(w.owner),
    team = id();
  db.prepare(
    "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES(?,?,'Brief fixture team',?,0)",
  ).run(team, w.owner, w.agent);
  db.prepare("INSERT INTO team_members(team_id,agent_id) VALUES(?,?)").run(
    team,
    worker.agent,
  );
  db.prepare("UPDATE runs SET state='running',payload=? WHERE id=?").run(
    JSON.stringify({ teamId: team, folderId: w.project }),
    w.runs[0],
  );
  const { invokeNative, nativeBindings } =
    await import("../src/server/native-tools");
  const run = db
    .prepare("SELECT * FROM runs WHERE id=?")
    .get(w.runs[0]) as import("../src/server/queue").Run;
  await invokeNative(
    run,
    nativeBindings(run).find((b) => b.tool === "loop_delegate")!,
    "fixture-delegate",
    {
      tasks: [
        { agentId: worker.agent, input: "Adopt my agent-authored proposal" },
      ],
    },
  );
  const message = db
    .prepare(
      "SELECT m.id,m.metadata FROM messages m JOIN delegations d ON d.child_run_id=m.run_id WHERE d.parent_run_id=? AND m.role='user'",
    )
    .get(run.id) as { id: string; metadata: string };
  expect(JSON.parse(message.metadata).automation).toBeUndefined();
  expect(
    resolveCite(w.owner, w.project, { ref: "msg_" + message.id }),
  ).toMatchObject({ automated: true });
  const decision = (messageId: string) => ({
    kind: "decision",
    text: "The owner decided",
    cite: [{ ref: "msg_" + messageId }],
    evidence: "owner_message",
    decided_by: "you",
  });
  expect(w.apply([decision(message.id)]).outcome).toBe("failed");
  db.prepare(
    "INSERT INTO workflow_steps(run_id,step_id,position,state,child_run_id) VALUES(?,'child',0,'running',?)",
  ).run(w.runs[0], w.runs[1]);
  expect(w.apply([decision(w.messages[1])]).outcome).toBe("failed");
  expect(w.apply([decision(w.messages[0])]).outcome).toBe("published");
});

it("deletes brief cursor and acknowledgement state with its project", () => {
  const w = fixture();
  w.apply([w.state()]);
  db.prepare(
    "UPDATE brief_state SET goal='Owner goal' WHERE owner_id=? AND project_id=?",
  ).run(w.owner, w.project);
  db.prepare(
    "INSERT INTO brief_acks(owner_id,project_id,version,at) VALUES(?,?,1,?)",
  ).run(w.owner, w.project, now());
  db.prepare("UPDATE conversations SET project_id=NULL WHERE project_id=?").run(
    w.project,
  );
  db.prepare("DELETE FROM folders WHERE id=? AND owner_id=?").run(
    w.project,
    w.owner,
  );
  for (const table of [
    "brief_items",
    "project_briefs",
    "brief_state",
    "brief_acks",
  ])
    expect(
      db
        .prepare(`SELECT 1 FROM ${table} WHERE owner_id=? AND project_id=?`)
        .get(w.owner, w.project),
    ).toBeUndefined();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Restored project',0)",
  ).run(w.project, w.owner);
  expect(w.read()).toMatchObject({
    version: 0,
    goal: null,
    acknowledged_version: 0,
  });
});

it("retains supersession regardless of the model item order", () => {
  const w = fixture();
  const decision = {
    kind: "decision",
    text: "Original choice",
    cite: [{ ref: "msg_" + w.messages[0] }],
    evidence: "owner_message",
    decided_by: "you",
  };
  w.apply([decision]);
  const old = w.items()[0];
  w.apply([
    { ...decision, text: "Replacement", supersedes: old.id },
    { ...decision, id: old.id, status: "active" },
  ]);
  expect(w.items().find((i) => i.id === old.id)?.status).toBe("superseded");
});

it("resolves PR comments only from their recorded delivery", async () => {
  const w = fixture(),
    watchId = id(),
    comment = id(),
    deliveredAt = now();
  db.prepare(
    "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,created_at,updated_at) VALUES(?,?,?,?,'org','repo',9,'watching',0,0)",
  ).run(watchId, w.owner, w.threads[0], w.agent);
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_42" })).toBeNull();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user','Stored GitHub comment: use the verified design.',?,?)",
  ).run(
    comment,
    w.owner,
    w.threads[0],
    w.runs[0],
    JSON.stringify({ automation: { kind: "github_watch", watchId } }),
    deliveredAt,
  );
  db.prepare("INSERT INTO pr_watch_deliveries VALUES(?,?,?)").run(
    watchId,
    w.runs[0],
    deliveredAt,
  );
  db.prepare(
    "INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at) VALUES(?,?,'pr_update',?,?,?)",
  ).run(w.owner, w.project, watchId + ":comment:42", w.threads[0], deliveredAt);
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_42" })).toMatchObject({
    kind: "pr",
    content: "Stored GitHub comment: use the verified design.",
    merged: false,
  });
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_43" })).toBeNull();
  db.prepare("UPDATE pr_watches SET state='paused' WHERE id=?").run(watchId);
  // Resume clears rate-limit deliveries, but must not erase citation identity.
  const { resumeWatch } = await import("../src/server/pr-watches");
  resumeWatch(w.owner, watchId);
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_42" })).toMatchObject({
    kind: "pr",
    content: "Stored GitHub comment: use the verified design.",
  });
  db.prepare(
    "UPDATE pr_watches SET state='stopped',ended_reason='Merged' WHERE id=?",
  ).run(watchId);
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_42" })).toMatchObject({
    merged: false,
  });
  const other = fixture(w.owner),
    later = id();
  db.prepare("UPDATE conversations SET project_id=NULL WHERE id=?").run(
    w.threads[0],
  );
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Later work','completed',?,?,1000,1000)",
  ).run(
    later,
    w.owner,
    w.agent,
    w.threads[0],
    later,
    JSON.stringify({ folderId: other.project }),
  );
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_42" })).not.toBeNull();
  expect(resolveCite(w.owner, other.project, { ref: "pr_9:c_42" })).toBeNull();
  expect(w.read().artifacts).toContainEqual({
    kind: "pr",
    ref: watchId,
    state: "merged",
  });
  expect(other.read().artifacts.some((a) => a.ref === watchId)).toBe(false);
  // Explicitly filing the conversation still moves the source's current scope.
  db.prepare("UPDATE conversations SET project_id=? WHERE id=?").run(
    other.project,
    w.threads[0],
  );
  expect(resolveCite(w.owner, w.project, { ref: "pr_9:c_42" })).toBeNull();
  expect(
    resolveCite(w.owner, other.project, { ref: "pr_9:c_42" }),
  ).not.toBeNull();
});

it("revalidates recorded evidence on an existing decision when omitted from an update", () => {
  const w = fixture();
  const decision = {
    kind: "decision",
    text: "Owner choice",
    cite: [{ ref: "msg_" + w.messages[0] }],
    evidence: "owner_message",
    decided_by: "you",
  };
  w.apply([decision]);
  const item = w.items()[0];
  db.prepare("UPDATE brief_items SET pinned=1 WHERE id=?").run(item.id);
  const { evidence, ...update } = decision;
  for (let i = 0; i < 2; i++)
    expect(
      w.apply([{ ...update, id: item.id, text: "Changed words" }]).outcome,
    ).toBe("unchanged");
  expect(w.items()).toHaveLength(1);
  expect(w.items()[0]).toMatchObject({
    text: "Owner choice",
    evidence: "owner_message",
    pinned: true,
  });
  const rejected = w.apply([{ ...update, id: item.id, cite: w.cite }]);
  expect("errors" in rejected && rejected.errors.map((e) => e.code)).toContain(
    "evidence_mismatch",
  );
});

it("attributes an evidence-free question from an owner message to the owner", () => {
  const w = fixture();
  w.apply([
    {
      kind: "decision",
      text: "Should we choose this?",
      cite: [{ ref: "msg_" + w.messages[0] }],
      decided_by: "you",
    },
  ]);
  expect(w.items()[0]).toMatchObject({ kind: "question", asked_by: "you" });
});

it("treats nullable optional fields as unchanged after storage", () => {
  const w = fixture();
  const decision = {
    kind: "decision",
    text: "Chosen",
    evidence: "owner_message",
    decided_by: "you",
    supersedes: null,
    cite: [{ ref: "msg_" + w.messages[0] }],
  };
  const question = {
    kind: "question",
    text: "A question",
    asked_by: w.agent,
    answered_cite: null,
    cite: w.cite,
  };
  w.apply([decision, question]);
  const items = w.items();
  expect(
    w.apply([
      { ...decision, id: items.find((i) => i.kind === "decision")!.id },
      { ...question, id: items.find((i) => i.kind === "question")!.id },
    ]).outcome,
  ).toBe("unchanged");
  expect(w.read().version).toBe(1);
});

it("truncates oversized quotes to an exact contained excerpt", () => {
  const w = fixture(),
    source = "verified design " + "x".repeat(400);
  db.prepare("UPDATE artifacts SET content=? WHERE id=?").run(
    source,
    w.artifacts[0],
  );
  const result = w.apply([
    { ...w.state(), cite: [{ ref: "res_" + w.artifacts[0], quote: source }] },
  ]);
  expect(result.outcome).toBe("published");
  expect("errors" in result && result.errors.map((e) => e.code)).toContain(
    "bound_exceeded",
  );
  expect(w.items()[0].cite[0].quote).toHaveLength(300);
  expect(checkQuote(source, w.items()[0].cite[0].quote)).toBe(true);
});

it("keeps paused and expired-approval threads in live attention", () => {
  const w = fixture();
  db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(w.runs[0]);
  expect(w.read()).toMatchObject({
    status: "needs_you",
    needs_you: [
      { kind: "question", ref: w.runs[0], conversation: w.threads[0] },
    ],
  });
  db.prepare("UPDATE runs SET state='awaiting_approval' WHERE id=?").run(
    w.runs[0],
  );
  db.prepare(
    "UPDATE approvals SET state='pending',expires_at=0 WHERE id=?",
  ).run(w.approval);
  expect(w.read().status).toBe("needs_you");
});

it("backfills durable PR citation bindings when upgrading existing history", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { readdirSync, readFileSync } = await import("node:fs");
  const prior = new Database(":memory:");
  try {
    prior.pragma("foreign_keys=ON");
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql") && f < "078-")
      .sort())
      prior.exec(readFileSync("migrations/" + file, "utf8"));
    prior.exec(`
      INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('project','owner','project','Existing',0);
      INSERT INTO conversations(id,owner_id,title,project_id,created_at) VALUES('thread','owner','Existing','project',0);
      INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('run','owner','thread','Existing','completed','run',0,0);
      INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('message','owner','thread','run','user','Original delivered content','{"automation":{"kind":"github_watch","watchId":"watch"}}',0);
      INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,created_at,updated_at) VALUES('watch','owner','thread','agent','org','repo',9,0,0);
      INSERT INTO pr_watch_deliveries VALUES('watch','run',42);
      INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at) VALUES('owner','project','pr_update','watch:comment:99','thread',42);
    `);
    prior.exec(readFileSync("migrations/078-project-briefs.sql", "utf8"));
    const row = prior
      .prepare("SELECT content,metadata FROM messages WHERE id='message'")
      .get() as { content: string; metadata: string };
    expect(row.content).toBe("Original delivered content");
    expect(JSON.parse(row.metadata)).toEqual({
      automation: { kind: "github_watch", watchId: "watch" },
      brief_pr_refs: ["watch:comment:99"],
    });
    expect(prior.pragma("foreign_key_check")).toEqual([]);
  } finally {
    prior.close();
  }
});

it("rejects archived results and unpublished placeholders as citations", () => {
  const w = fixture();
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(w.artifacts[0]);
  expect(
    resolveCite(w.owner, w.project, { ref: "res_" + w.artifacts[0] }),
  ).toBeNull();
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(w.runs[1]);
  const placeholder = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,'Pending','markdown','Not final',0,0)",
  ).run(placeholder, w.owner, w.threads[1], w.runs[1]);
  expect(
    resolveCite(w.owner, w.project, { ref: "res_" + placeholder }),
  ).toBeNull();
});

it("resolves recorded failed and successful CI updates as brief evidence", async () => {
  const w = fixture(),
    watch = id();
  const { submit } = await import("../src/server/agent-runtime");
  db.prepare(
    "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,created_at,updated_at) VALUES(?,?,?,?,'org','repo',7,0,0)",
  ).run(watch, w.owner, w.threads[0], w.agent);
  for (const [index, conclusion] of ["failure", "success"].entries()) {
    const hash = id(),
      text = "Recorded CI " + conclusion,
      at = 1000 + index;
    const run = submit(w.owner, {
      agentId: w.agent,
      conversationId: w.threads[0],
      input: text,
      idempotencyKey: id(),
      automation: { kind: "github_watch", watchId: watch },
    });
    db.prepare("INSERT INTO pr_watch_deliveries VALUES(?,?,?)").run(
      watch,
      run.id,
      at,
    );
    db.prepare(
      "INSERT INTO project_changes(owner_id,project_id,kind,ref,conversation_id,at) VALUES(?,?,'pr_update',?,?,?)",
    ).run(
      w.owner,
      w.project,
      watch + ":ci_" + conclusion + ":" + hash,
      w.threads[0],
      at,
    );
    const cite = { ref: "pr_7:c_" + hash, quote: text };
    expect(resolveCite(w.owner, w.project, cite)).toMatchObject({
      kind: "pr",
      content: text,
      merged: false,
    });
    expect(w.apply([{ ...w.state(text), cite: [cite] }]).outcome).toBe(
      "published",
    );
  }
});

it("retains stale answer citations when an update omits the answer field", () => {
  const w = fixture(),
    answer = { ref: "msg_" + w.messages[1] };
  const question = {
    kind: "question",
    text: "Which design?",
    asked_by: "you",
    status: "answered",
    cite: w.cite,
    answered_cite: answer,
  };
  w.apply([question]);
  const item = w.items()[0];
  db.prepare("DELETE FROM messages WHERE id=?").run(w.messages[1]);
  const { answered_cite, ...update } = question;
  const result = w.apply([{ ...update, id: item.id }]);
  expect("errors" in result && result.errors.map((e) => e.code)).toContain(
    "cite_unresolved",
  );
  expect(w.items()[0]).toMatchObject({
    answered_cite: answer,
    cite_stale: true,
  });
  w.apply([{ ...update, id: item.id }]);
  expect(w.items()[0].cite_stale).toBe(true);
  w.apply([{ ...update, id: item.id, answered_cite: null }]);
  expect(w.items()[0].cite_stale).toBe(false);
});

it("preserves an explicit reversal when a successor stays active", () => {
  const w = fixture();
  const decision = {
    kind: "decision",
    text: "Initial choice",
    evidence: "owner_message",
    decided_by: "you",
    cite: [{ ref: "msg_" + w.messages[0] }],
  };
  w.apply([decision]);
  const original = w.items()[0];
  w.apply([{ ...decision, text: "Successor", supersedes: original.id }]);
  w.apply([{ ...decision, id: original.id, status: "reverted" }]);
  expect(w.items().find((i) => i.id === original.id)?.status).toBe("reverted");
  w.apply([]);
  expect(w.items().find((i) => i.id === original.id)?.status).toBe("reverted");
});

it("checks the complete oversized quote before storing its bounded excerpt", () => {
  const w = fixture(),
    source = "verified design " + "x".repeat(400);
  db.prepare("UPDATE artifacts SET content=? WHERE id=?").run(
    source,
    w.artifacts[0],
  );
  const result = w.apply([
    {
      ...w.state(),
      cite: [
        { ref: "res_" + w.artifacts[0], quote: source + " invented ending" },
      ],
    },
  ]);
  expect(result.outcome).toBe("failed");
  expect("errors" in result && result.errors.map((e) => e.code)).toContain(
    "quote_not_contained",
  );
});

it("persists a compact reading layer and an exact owner request alongside the full record", () => {
  const w = fixture();
  const summary = {
    title: "Use the verified design",
    update: "forest reports the change on main. App update pending.",
    stage: "awaiting_update",
    request: { ref: "msg_" + w.messages[0], quote: "Use the verified design." },
  };
  expect(w.apply([{ ...w.state(), summary }]).outcome).toBe("published");
  expect(w.read().state[0]).toMatchObject({ text: w.state().text, summary });
  const saved = w.items()[0];
  expect(w.apply([{ ...w.state(), id: saved.id, summary }]).outcome).toBe(
    "unchanged",
  );
  // Older providers must not leave yesterday's short update attached to new facts.
  w.apply([{ ...w.state("The design needs another review"), id: saved.id }]);
  expect(w.read().state[0].summary).toBeUndefined();
});

it.each(["invented", "automated", "assistant", "other-project", "empty"])(
  "never publishes %s words as the owner's original request",
  (kind) => {
    const w = fixture();
    let ref = "msg_" + w.messages[0];
    if (kind === "automated")
      db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(
        '{"automation":{"kind":"schedule"}}',
        w.messages[0],
      );
    if (kind === "assistant")
      db.prepare("UPDATE messages SET role='assistant' WHERE id=?").run(
        w.messages[0],
      );
    if (kind === "other-project") ref = "msg_" + fixture(w.owner).messages[0];
    const quote =
      kind === "invented"
        ? "These are not the owner's words."
        : kind === "empty"
          ? ""
          : "Use the verified design.";
    expect(
      w.apply([
        {
          ...w.state(),
          summary: { title: "Verified design", request: { ref, quote } },
        },
      ]).outcome,
    ).toBe("failed");
    expect(w.read().state).toHaveLength(0);
  },
);

it("preserves a pinned reading layer and clears it when the owner changes the wording", async () => {
  const { editItem } = await import("../src/server/briefs/owner");
  const w = fixture();
  const summary = {
    title: "Use the verified design",
    update: "Ready to review.",
  };
  w.apply([{ ...w.state(), summary }]);
  const item = w.items()[0];
  editItem(w.owner, w.project, item.id, { pinned: true });
  w.apply([
    { ...w.state(), id: item.id, summary: { title: "Different wording" } },
  ]);
  expect(w.items()[0].summary).toEqual(summary);
  editItem(w.owner, w.project, item.id, { text: "My preferred words" });
  expect(w.items()[0]).toMatchObject({
    text: "My preferred words",
    pinned: true,
  });
  expect(w.items()[0].summary).toBeUndefined();
  w.apply([{ ...w.state(), id: item.id, summary }]);
  expect(w.items()[0].summary).toBeUndefined();
  expect(w.items()[0].text).toBe("My preferred words");
});

it("does not truncate a reading update and lose its uncertainty", () => {
  const w = fixture();
  const update = "A".repeat(160) + " but the fix is unconfirmed.";
  const result = w.apply([
    { ...w.state(), summary: { title: "Review the fix", update } },
  ]);
  expect(result).toMatchObject({
    errors: [expect.objectContaining({ code: "invalid_output" })],
  });
  expect(w.read().state[0].summary).toBeUndefined();
  expect(w.read().state[0].text).toBe(w.state().text);
});
