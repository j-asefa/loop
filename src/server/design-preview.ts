import { watchRun } from "./run-signal.js";
import { writeConnectionStatus } from "./connection-status.js";
import type { RequestHandler } from "express";
import { designPreview } from "../preview-context.js";
import { db, changes, emit, id, now } from "./db.js";
import { OWNER } from "./native-sessions.js";
import { createAgent, owned, Problem } from "./domain.js";
import { seal } from "./secrets.js";
import { saveArtifact } from "./artifacts.js";
import { ensureWorkspaceProject } from "./workspace-project.js";
import { claim, type Run } from "./queue.js";
import { SteeringInbox } from "./steering.js";
import { decide } from "./approvals.js";

const MODEL = "preview-simulator";
const REPLY =
  "**Simulated reply**\n\nYour message was received in this design preview. You can test replies, navigation and saved results here. No model was contacted and no tools were run.";
const models = [
  {
    id: MODEL,
    name: "Simulated reply",
    capabilities: "Design preview; no model requests",
  },
];

/** Only reviewed, database-local routes are reachable in a design preview.
 * New integrations fail closed, including GET routes that discover native accounts.
 */
export const designPreviewBoundary: RequestHandler = (req, res, next) => {
  if (!designPreview) {
    next();
    return;
  }
  const path = req.path;
  if (req.method === "GET" && /^\/connections\/[^/]+\/models$/.test(path)) {
    const connection = owned<{ models: string }>(
      "connections",
      path.split("/")[2],
      res.locals.owner,
    );
    res.json({ models: JSON.parse(connection.models) });
    return;
  }
  if (req.method === "GET" && path === "/workspace") {
    res.json({
      harnesses: [],
      nativeProcesses: 0,
      concurrency: 0,
      projectPaths: [],
      hostLifetime: "preview",
    });
    return;
  }
  if (req.method === "GET" && path === "/workspace/runtimes") {
    res.json({ computer: "Design preview", online: true, runtimes: [] });
    return;
  }
  if (
    req.method === "GET" &&
    (/^\/(build|bootstrap|runs|events|approvals|feed(?:\/away)?|projects\/summary|saved|later|scheduled-sends|snippets|folders|results(?:\/updates)?|messages|artifacts|teams|team-presets|preferences|search(?:\/status)?|me\/(?:profile|prompts|files)|auth\/get-session|auth-options|capabilities)$/.test(
      path,
    ) ||
      /^\/agents\/[^/]+(?:\/(?:messages|traces(?:\/export)?))?$/.test(path) ||
      /^\/conversations\/[^/]+(?:\/(?:activities|outline|usage))?$/.test(
        path,
      ) ||
      /^\/(?:messages|artifacts|objects)\/[^/]+$/.test(path) ||
      /^\/runs\/[^/]+\/(?:checkout|verifications|files)$/.test(path))
  ) {
    next();
    return;
  }
  // Ordinary submits retain their durable request keys; the simulator alone consumes them.
  if (
    req.method === "POST" &&
    (/^\/(?:runs|agents)$/.test(path) ||
      /^\/runs\/[^/]+\/(?:cancel|pause|resume|retry|dismiss)$/.test(path) ||
      /^\/messages\/[^/]+\/saved$/.test(path) ||
      /^\/projects\/[^/]+\/opened$/.test(path))
  ) {
    next();
    return;
  }
  if (req.method === "PATCH" && /^\/(?:feed|results)\/[^/]+$/.test(path)) {
    next();
    return;
  }
  if (req.method === "PUT" && /^\/conversations\/[^/]+\/position$/.test(path)) {
    next();
    return;
  }
  if (req.method === "DELETE" && /^\/messages\/[^/]+\/saved$/.test(path)) {
    next();
    return;
  }
  // Resolve a sample approval locally, without entering the MCP/tool dispatch path.
  const approval = /^\/approvals\/([^/]+)$/.exec(path);
  if (approval && req.method === "POST") {
    const row = owned<{ run_id: string; state: string }>(
      "approvals",
      approval[1],
      res.locals.owner,
    );
    if (!["approve", "reject"].includes(req.body?.decision))
      throw new Problem(400, "Choose approve or reject");
    const run = owned<Run>("runs", row.run_id, res.locals.owner);
    if (row.state !== "pending" || run.state !== "awaiting_approval")
      throw new Problem(409, "This approval is no longer pending");
    db.transaction(() => {
      const approved = req.body.decision === "approve";
      // Reuse ownership, expiry and rejection semantics; no dispatcher runs in design mode.
      decide(res.locals.owner, approval[1], req.body.decision);
      db.prepare("UPDATE approvals SET state=?,result=? WHERE id=?").run(
        approved ? "completed" : "rejected",
        "Simulated decision; nothing was sent externally.",
        approval[1],
      );
      if (approved)
        finish(
          run,
          "Preview approval accepted. This is a simulation; no review was posted.",
        );
    }).immediate();
    res.json({ ok: true });
    return;
  }
  res.status(403).json({
    error:
      "This action is unavailable in a design preview. Messages are simulated; use a working preview to test integrations.",
  });
};

function reply(run: Run, content: string, partial = false) {
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    message,
    run.owner_id,
    run.conversation_id,
    run.id,
    "assistant",
    content,
    JSON.stringify({ preview: true, ...(partial ? { partial: true } : {}) }),
    now(),
  );
  return message;
}

function finish(run: Run, content: string) {
  // Called inside the simulator's transaction: messages and delivery receipts commit together.
  new SteeringInbox(run).appendPending([]);
  const message = reply(run, content),
    time = now();
  const artifact = saveArtifact(run.owner_id, {
    title: run.input.slice(0, 120),
    content,
    agent: run.agent_id,
    conversation: run.conversation_id,
    run: run.id,
    folder: JSON.parse(run.payload).folderId,
    metadata: { messageId: message, preview: true, model: MODEL },
  });
  db.prepare(
    "INSERT OR REPLACE INTO agent_checkpoints(run_id,message_id,artifact_id,history,output,stage) VALUES(?,?,?,?,?,'done')",
  ).run(run.id, message, artifact, "[]", content);
  db.prepare(
    `UPDATE runs SET result=?,state='completed',worker_id=NULL,heartbeat=NULL,updated_at=?,
      active_ms=active_ms+CASE WHEN active_since IS NOT NULL THEN max(0,?-active_since) ELSE 0 END,
      active_since=NULL WHERE id=? AND owner_id=?`,
  ).run(content, time, time, run.id, run.owner_id);
  emit(run.owner_id, run.id, "completed", { preview: true });
}

/** Seed once. A rebuild preserves edits and pairing rather than duplicating the fixture. */
export function seedDesignPreview() {
  if (!designPreview) throw new Error("Sample data requires a design preview");
  db.exec(
    "CREATE TABLE IF NOT EXISTS design_preview_seed(version INTEGER PRIMARY KEY)",
  );
  if (db.prepare("SELECT 1 FROM design_preview_seed WHERE version=1").get())
    return;
  if (
    db.prepare("SELECT 1 FROM agents LIMIT 1").get() ||
    db.prepare("SELECT 1 FROM connections LIMIT 1").get()
  )
    throw new Error("Design previews require a fresh sample workspace.");
  db.transaction(() => {
    const project = ensureWorkspaceProject(OWNER),
      connection = id();
    writeConnectionStatus(connection, () => db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Preview simulator',?,'connected',?,'{\"preview\":true}',?)",
    ).run(
      connection,
      OWNER,
      seal("preview-only-not-a-provider-key", OWNER),
      JSON.stringify(models),
      now(),
    ));
    const agents = ["willow", "cedar", "iris", "fern", "maple"].map((name) =>
      createAgent(OWNER, {
        name,
        connectionId: connection,
        model: MODEL,
        instructions: "Sample agent for this design preview.",
        folderId: project,
      }),
    );
    const scenarios = [
      [
        "completed",
        "Explore posts and comments for the feed",
        "A session can be one post, with progress and follow-up replies underneath. Keep decisions visible and let readers jump to the latest update.",
      ],
      [
        "running",
        "Check the mobile layout",
        "I’m comparing the feed on a narrow screen and checking how long conversations open.",
      ],
      [
        "awaiting_approval",
        "Share the design review",
        "The review is ready. This sample approval lets you explore the decision flow.",
      ],
      [
        "failed",
        "Recover after a connection drops",
        "The connection dropped. The draft and earlier results are still available.",
      ],
      [
        "queued",
        "Write a short summary of the experiment",
        "This sample task is waiting in the queue.",
      ],
    ];
    scenarios.forEach(([state, title, content], index) => {
      const agent = agents[index],
        conversation = id(),
        runId = id(),
        time = now() - (index + 1) * 3600000;
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(conversation, OWNER, agent.id, title, project, time);
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        runId,
        OWNER,
        agent.id,
        conversation,
        title,
        state,
        runId,
        JSON.stringify({
          agentId: agent.id,
          connectionId: connection,
          provider: "openai",
          model: MODEL,
          folderId: project,
          previewFixture: true,
        }),
        state === "failed" ? content : null,
        time,
        time,
      );
      const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Run;
      const turns = index === 0 ? 24 : 1;
      for (let turn = 0; turn < turns; turn++) {
        db.prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id(),
          OWNER,
          conversation,
          runId,
          "user",
          turn === 0
            ? title
            : `Iteration ${turn}: make the hierarchy clearer and keep the earlier discussion easy to find.`,
          time + turn * 2000,
        );
        if (turn < turns - 1 || state !== "completed")
          db.prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            id(),
            OWNER,
            conversation,
            runId,
            "assistant",
            content,
            JSON.stringify({ preview: true, partial: state === "running" }),
            time + turn * 2000 + 1,
          );
      }
      if (state === "completed")
        finish(
          run,
          "## A quieter feed\n\n" +
            content +
            "\n\n- One post per session\n- Comments for progress and replies\n- Decisions stay easy to find\n\nThis is sample content. Send a message to try a simulated reply.",
        );
      if (state === "awaiting_approval")
        db.prepare(
          "INSERT INTO approvals(id,owner_id,run_id,digest,request,state,created_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)",
        ).run(
          id(),
          OWNER,
          runId,
          runId,
          JSON.stringify({
            type: "mcp_tool",
            tool: "post_review",
            server: "Sample GitHub",
            arguments: { body: content },
            message: "Share this sample review? No external action will occur.",
          }),
          time,
          now() + 365 * 86400000,
        );
    });
    db.prepare("INSERT INTO design_preview_seed VALUES(1)").run();
  }).immediate();
}

/** No real worker, model adapter, harness, scheduler, notification or MCP dispatcher runs. */
export function startDesignSimulation() {
  if (!designPreview) throw new Error("Simulation requires a design preview");
  let stopped = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  const watched = new Map<string, ReturnType<typeof watchRun>>();
  const wake = () => {
    if (stopped || scheduled) return;
    scheduled = setImmediate(() => { scheduled = undefined; tick(); });
  };
  const reconcile = () => {
    const live = db.prepare("SELECT * FROM runs WHERE owner_id=? AND state IN ('queued','running','awaiting_approval')").all(OWNER) as Run[];
    const ids = new Set(live.map((run) => run.id));
    for (const [id, subscription] of watched) if (!ids.has(id)) {
      subscription.release(); watched.delete(id);
    }
    for (const run of live) if (!watched.has(run.id)) {
      const subscription = watchRun(run);
      subscription.on("fallback", wake);
      watched.set(run.id, subscription);
    }
  };
  const tick = () => {
    db
      .transaction(() => {
        db.prepare(
          "INSERT OR REPLACE INTO worker_health VALUES('design-preview',?)",
        ).run(now());
        for (let i = 0; i < 10; i++) {
          // Use the ordinary queue's approval, pause and ordering barriers without dispatching work.
          const run = claim(
            "design-preview",
            (candidate) =>
              candidate.owner_id === OWNER &&
              candidate.kind === "agent" &&
              candidate.state === "queued" &&
              (!JSON.parse(candidate.payload).previewFixture ||
                !!db
                  .prepare(
                    "SELECT 1 FROM events WHERE owner_id=? AND run_id=? AND type='queued' LIMIT 1",
                  )
                  .get(OWNER, candidate.id)),
          );
          if (!run) break;
          finish(run, REPLY);
        }
        const steered = db
          .prepare(
            `SELECT * FROM runs WHERE owner_id=? AND state IN ('running','awaiting_approval')
            AND EXISTS(SELECT 1 FROM run_steering s WHERE s.owner_id=runs.owner_id AND s.run_id=runs.id AND s.state='pending')
            ORDER BY created_at LIMIT 10`,
          )
          .all(OWNER) as Run[];
        for (const run of steered) {
          if (run.state === "awaiting_approval") {
            new SteeringInbox(run).appendPending([]);
            reply(
              run,
              REPLY +
                "\n\nThe sample approval is still waiting for your decision.",
              true,
            );
          } else finish(run, REPLY);
        }
      })
      .immediate();
    reconcile();
  };
  const unsubscribe = changes.subscribe(OWNER, (events) => {
    if (events.some(({ type }) => ["queued", "running", "completed", "failed", "cancelled", "interrupted", "steering.pending"].includes(type) || type.startsWith("approval."))) wake();
  });
  tick();
  // The simulation still advertises liveness without polling run/steering rows.
  const timer = setInterval(() => db.prepare("INSERT OR REPLACE INTO worker_health VALUES('design-preview',?)").run(now()), 5000);
  return async () => {
    stopped = true;
    if (scheduled) clearImmediate(scheduled);
    unsubscribe();
    for (const subscription of watched.values()) subscription.release();
    clearInterval(timer);
    db.prepare("DELETE FROM worker_health WHERE id='design-preview'").run();
  };
}
