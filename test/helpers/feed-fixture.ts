// A seeded workspace covering every card shape the Feed and the results
// stream can show, with deterministic ids and timestamps. Rows are inserted
// with SQL, not through production helpers, so the fixture stays fixed while
// the code that reads it changes. Used by the Feed snapshot test, which is
// the correctness oracle for the Feed storage work.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const OWNER = "owner-feed";
/** The fixed "now" every response is computed against. */
export const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

let counted = 0;
/** SQL statement executions (run/get/all/iterate) since the last reset. */
export const statements = () => counted;
export const resetStatements = () => {
  counted = 0;
};

export async function createFeedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "loop-feed-fixture-"));
  process.env.LOOP_DATA_DIR = dir;
  process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  const { db } = await import("../../src/server/db");
  countStatements(db);
  seed(db);
  resetStatements();
  return {
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function countStatements(db: import("better-sqlite3").Database) {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql) as any;
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const original = statement[method].bind(statement);
      statement[method] = (...args: unknown[]) => {
        counted++;
        return original(...args);
      };
    }
    return statement;
  }) as typeof db.prepare;
}

function seed(db: import("better-sqlite3").Database) {
  let clock = NOW - 100 * HOUR;
  const tick = () => (clock += 60_000);
  const sql = (text: string, ...args: unknown[]) =>
    db.prepare(text).run(...args);
  const json = (value: unknown) => JSON.stringify(value);

  // Connections and agents.
  const models = json([{ id: "fixture-model", name: "Fixture model" }]);
  sql(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    "conn-api",
    OWNER,
    "openai",
    "API",
    "",
    "connected",
    models,
    "{}",
    tick(),
  );
  sql(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    "conn-native",
    OWNER,
    "codex",
    "Codex",
    "",
    "connected",
    models,
    json({ loopHarness: "codex" }),
    tick(),
  );
  const agent = (
    id: string,
    name: string,
    provider: string,
    connection: string,
  ) =>
    sql(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      OWNER,
      name,
      name,
      provider,
      connection,
      "fixture-model",
      "",
      tick(),
    );
  agent("agent-api", "api-agent", "openai", "conn-api");
  agent("agent-native", "native-agent", "codex", "conn-native");
  agent("agent-manager", "manager-agent", "openai", "conn-api");
  agent("agent-member", "member-agent", "openai", "conn-api");

  // A project with a folder nested two levels deep.
  const folder = (
    id: string,
    parent: string | null,
    kind: string,
    name: string,
  ) =>
    sql(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,?,?,?)",
      id,
      OWNER,
      parent,
      kind,
      name,
      tick(),
    );
  folder("proj", null, "project", "Project");
  folder("proj-sub", "proj", "folder", "Sub");
  folder("proj-deep", "proj-sub", "folder", "Deep");

  sql(
    "INSERT INTO teams(id,owner_id,name,manager_id,conversation_id,created_at) VALUES(?,?,?,?,?,?)",
    "team-1",
    OWNER,
    "Team",
    "agent-manager",
    null,
    tick(),
  );
  sql(
    "INSERT INTO team_members(team_id,agent_id) VALUES(?,?)",
    "team-1",
    "agent-member",
  );

  const conversation = (
    id: string,
    agentId: string | null,
    title: string,
    extra: { team?: string; project?: string } = {},
  ) =>
    sql(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at,team_id,project_id) VALUES(?,?,?,?,?,?,?)",
      id,
      OWNER,
      agentId,
      title,
      tick(),
      extra.team ?? null,
      extra.project ?? null,
    );
  const run = (
    id: string,
    conversationId: string | null,
    agentId: string | null,
    state: string,
    extra: {
      input?: string;
      payload?: object;
      worker?: string | null;
      error?: string;
      dismissed?: boolean;
      kind?: string;
    } = {},
  ) => {
    const time = tick();
    sql(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,error,worker_id,created_at,updated_at,attention_dismissed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      OWNER,
      agentId,
      conversationId,
      extra.kind ?? "agent",
      extra.input ?? `Prompt for ${id}`,
      state,
      "key-" + id,
      json(
        extra.payload ?? { connectionId: "conn-api", model: "fixture-model" },
      ),
      extra.error ?? null,
      extra.worker ?? null,
      time,
      time,
      extra.dismissed ? time : null,
    );
  };
  const message = (
    id: string,
    conversationId: string,
    runId: string | null,
    role: string,
    content: string,
    metadata: object = {},
  ) =>
    sql(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      OWNER,
      conversationId,
      runId,
      role,
      content,
      json(metadata),
      tick(),
    );
  const artifact = (
    id: string,
    conversationId: string | null,
    runId: string | null,
    agentId: string | null,
    content: string,
    metadata: object,
    extra: {
      kind?: string;
      folder?: string;
      pinned?: boolean;
      title?: string;
    } = {},
  ) => {
    const time = tick();
    sql(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,folder_id,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      OWNER,
      agentId,
      conversationId,
      runId,
      extra.title ?? `Result ${id}`,
      extra.kind ?? "markdown",
      content,
      json(metadata),
      extra.folder ?? null,
      extra.pinned ? 1 : 0,
      time,
      time,
    );
    sql(
      "INSERT INTO artifact_versions VALUES(?,?,?,?,?)",
      "v-" + id,
      id,
      1,
      content,
      time,
    );
  };
  const checkpoint = (
    runId: string,
    messageId: string,
    artifactId: string,
    stage: string,
    output = "",
  ) =>
    sql(
      "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history,stage,output) VALUES(?,?,?,?,?,?)",
      runId,
      messageId,
      artifactId,
      "[]",
      stage,
      output,
    );
  /** A finished thread: prompt, answer, and its published result. */
  const finished = (
    key: string,
    agentId: string,
    extra: {
      team?: string;
      payload?: object;
      native?: boolean;
      prompt?: object;
      pinned?: boolean;
      folder?: string;
    } = {},
  ) => {
    const c = "c-" + key,
      r = "r-" + key;
    conversation(c, agentId, `Thread ${key}`, extra);
    run(r, c, agentId, "running", { payload: extra.payload });
    message(
      "m-" + key + "-user",
      c,
      r,
      "user",
      `Question ${key}`,
      extra.prompt ?? {},
    );
    message("m-" + key + "-answer", c, r, "assistant", `Answer ${key}`);
    artifact(
      "a-" + key,
      c,
      r,
      agentId,
      `Answer ${key}`,
      extra.native
        ? { native: true, partial: true, messageId: "m-" + key + "-answer" }
        : { partial: true, messageId: "m-" + key + "-answer" },
      { folder: extra.folder, pinned: extra.pinned },
    );
    checkpoint(r, "m-" + key + "-answer", "a-" + key, "done", `Answer ${key}`);
    // Completion publishes the result, as the run_publish trigger does in use.
    db.prepare(
      "UPDATE artifacts SET metadata=json_set(metadata,'$.partial',json('false')) WHERE id=?",
    ).run("a-" + key);
    db.prepare(
      "UPDATE runs SET state='completed',result=?,updated_at=? WHERE id=?",
    ).run(`Answer ${key}`, tick(), r);
  };

  // Done: an API answer (saved, with a tool trace) and a native answer.
  finished("done-api", "agent-api", { pinned: true });
  artifact("a-done-api-tool", "c-done-api", "r-done-api", "agent-api", "[]", {
    tool: "search",
    connectionId: "mcp-1",
  });
  finished("done-native", "agent-native", {
    native: true,
    payload: { connectionId: "conn-native", model: "fixture-model" },
  });

  // Working: a running run with partial output, and one waiting on a child.
  conversation("c-running", "agent-api", "Running thread");
  run("r-running", "c-running", "agent-api", "running", { worker: "worker-1" });
  message("m-running-user", "c-running", "r-running", "user", "Keep going");
  message("m-running-answer", "c-running", "r-running", "assistant", "Halfway");
  artifact("a-running", "c-running", "r-running", "agent-api", "Halfway", {
    partial: true,
    messageId: "m-running-answer",
  });
  checkpoint("r-running", "m-running-answer", "a-running", "model", "Halfway");

  conversation("c-waiting", "agent-manager", "Waiting on a delegate");
  run("r-waiting", "c-waiting", "agent-manager", "running", { worker: null });
  message("m-waiting-user", "c-waiting", "r-waiting", "user", "Delegate this");
  // The delegate's own thread is internal work, never a Feed card or result.
  finished("delegate", "agent-member");
  sql(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,?)",
    "r-waiting",
    "call-1",
    "r-delegate",
    "{}",
    0,
  );

  for (const state of ["pausing", "paused", "failed", "interrupted"]) {
    conversation("c-" + state, "agent-api", `Thread ${state}`);
    run("r-" + state, "c-" + state, "agent-api", state, {
      worker: state === "pausing" ? "worker-1" : null,
      error:
        state === "failed" || state === "interrupted"
          ? `Run ${state}`
          : undefined,
    });
    message(
      `m-${state}-user`,
      "c-" + state,
      "r-" + state,
      "user",
      `Prompt ${state}`,
    );
  }
  conversation("c-dismissed", "agent-api", "Dismissed failure");
  run("r-dismissed", "c-dismissed", "agent-api", "failed", {
    error: "Run failed",
    dismissed: true,
  });
  message(
    "m-dismissed-user",
    "c-dismissed",
    "r-dismissed",
    "user",
    "Prompt dismissed",
  );

  // Queued: two follow-ups behind a running run of the same agent.
  conversation("c-queue", "agent-native", "Queue");
  run("r-queue-active", "c-queue", "agent-native", "running", {
    worker: "worker-1",
    payload: { connectionId: "conn-native", model: "fixture-model" },
  });
  message("m-queue-user", "c-queue", "r-queue-active", "user", "First");
  for (const n of [1, 2]) {
    run(`r-queue-${n}`, "c-queue", "agent-native", "queued", {
      input: `Follow-up ${n}`,
      payload: { connectionId: "conn-native", model: "fixture-model" },
    });
    message(
      `m-queue-${n}`,
      "c-queue",
      `r-queue-${n}`,
      "user",
      `Follow-up ${n}`,
    );
  }

  // Needs you: an approval pending (one live, one expired).
  conversation("c-approval", "agent-api", "Needs approval");
  run("r-approval", "c-approval", "agent-api", "awaiting_approval", {
    worker: "worker-1",
  });
  message("m-approval-user", "c-approval", "r-approval", "user", "Deploy it");
  message("m-approval-answer", "c-approval", "r-approval", "assistant", "");
  for (const [id, expires] of [
    ["ap-live", NOW + HOUR],
    ["ap-expired", NOW - HOUR],
  ] as const)
    sql(
      "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      OWNER,
      "r-approval",
      "digest-" + id,
      json({ tool: "deploy" }),
      "pending",
      tick(),
      expires,
    );

  // Later: one thread snoozed until tomorrow, one surfaced already.
  finished("snoozed", "agent-api");
  finished("surfaced", "agent-api");
  const later = (id: string, target: string, surfaced: number | null) =>
    sql(
      "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,created_at,surfaced_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      OWNER,
      "conversation",
      target,
      "time",
      surfaced ? NOW - HOUR : NOW + 24 * HOUR,
      tick(),
      surfaced,
    );
  later("later-snoozed", "c-snoozed", null);
  later("later-surfaced", "c-surfaced", NOW - HOUR);

  // Imported history: messages and no runs.
  conversation("c-imported", "agent-api", "Imported thread");
  message("m-imported-user", "c-imported", null, "user", "Imported question");
  message(
    "m-imported-answer",
    "c-imported",
    null,
    "assistant",
    "Imported answer",
  );

  // A team thread and a thread filed deep in the project.
  finished("team", "agent-manager", { team: "team-1" });
  sql("UPDATE teams SET conversation_id='c-team' WHERE id='team-1'");
  finished("project", "agent-api", {
    payload: {
      connectionId: "conn-api",
      model: "fixture-model",
      folderId: "proj-deep",
    },
    folder: "proj-deep",
  });
  // A Done card the owner swiped away; a later result would bring the
  // thread back as a new card.
  finished("dismissed-card", "agent-api");
  sql(
    "INSERT INTO done_card_dismissals(owner_id,conversation_id,card_key,created_at) VALUES(?,?,?,?)",
    OWNER,
    "c-dismissed-card",
    "run:r-dismissed-card",
    tick(),
  );

  // Started by automation, not typed by the owner.
  finished("automation", "agent-api", {
    prompt: { automation: { kind: "pull_request", fromName: "owner/repo#7" } },
  });

  // A workflow's child run is internal work too.
  run("r-workflow", null, null, "running", { kind: "workflow", payload: {} });
  finished("workflow-child", "agent-api");
  sql(
    "INSERT INTO workflow_steps(run_id,step_id,position,state,child_run_id) VALUES(?,?,?,?,?)",
    "r-workflow",
    "step-1",
    0,
    "completed",
    "r-workflow-child",
  );

  // Saved: a message without a result (a prompt), alongside the pinned answer.
  sql(
    "INSERT INTO message_bookmarks(owner_id,message_id,created_at) VALUES(?,?,?)",
    OWNER,
    "m-project-user",
    tick(),
  );

  // A reading position partway through a thread.
  sql(
    "INSERT INTO conversation_positions(owner_id,conversation_id,position_message_id,updated_at) VALUES(?,?,?,?)",
    OWNER,
    "c-done-api",
    "m-done-api-user",
    tick(),
  );

  // A file result with no run, filed in the project.
  artifact(
    "a-file",
    null,
    null,
    null,
    "file body",
    { name: "notes.txt" },
    {
      kind: "file",
      folder: "proj",
      title: "notes.txt",
    },
  );
}
