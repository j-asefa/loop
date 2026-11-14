import * as approvalsQueries from "./sql/approvals.js";
import * as agentCheckpointsQueries from "./sql/agent-checkpoints.js";
import * as designPreviewSeedQueries from "./sql/design-preview-seed.js";
import * as agentsQueries from "./sql/agents.js";
import * as connectionsQueries from "./sql/connections.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as workerHealthQueries from "./sql/worker-health.js";
import * as eventsQueries from "./sql/events.js";
import * as messagesQueries from "./sql/messages.js";
import * as runsQueries from "./sql/runs.js";
import { MessageMetadata, parseRun, parseRuns } from "./row-schemas.js";

import { watchRun } from "./run-signal.js";
import { writeConnectionStatus } from "./connection-status.js";
import type { RequestHandler } from "express";
import { designPreview } from "../preview-context.js";
import { db, changes, id, now } from "./db.js";
import { OWNER } from "./workspace-identity.js";
import {
  ownedConnection,
  ownedApproval,
  ownedRun,
  createAgent,
  Problem,
} from "./domain.js";
import { seal } from "./secrets.js";
import { saveArtifact } from "./artifacts.js";
import { ensureWorkspaceProject } from "./workspace-project.js";
import { claim, transition, type Run } from "./queue.js";
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
    const connection = ownedConnection(path.split("/")[2], res.locals.owner);
    res.json({ models: connection.models });
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
    (/^\/(build|bootstrap|runs|events|approvals|feed(?:\/away)?|projects\/summary|saved|later|scheduled-sends|snippets|folders|results(?:\/updates)?|messages|artifacts|teams|team-presets|preferences|search(?:\/status)?|me\/(?:profile|prompts|files|decisions)|auth\/get-session|capabilities)$/.test(
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
    const row = ownedApproval(approval[1], res.locals.owner);
    if (!["approve", "reject"].includes(req.body?.decision))
      throw new Problem(400, "Choose approve or reject");
    const run = ownedRun(row.run_id, res.locals.owner);
    if (row.state !== "pending" || run.state !== "awaiting_approval")
      throw new Problem(409, "This approval is no longer pending");
    db.transaction(() => {
      const approved = req.body.decision === "approve";
      // Reuse ownership, expiry and rejection semantics; no dispatcher runs in design mode.
      decide(res.locals.owner, approval[1], req.body.decision);
      approvalsQueries.previewDecision(
        db,
        approved ? "completed" : "rejected",
        "Simulated decision; nothing was sent externally.",
        approval[1],
      );
      if (approved) {
        // decide() requeues the sample. Use the ordinary atomic lease claim
        // before completing it; queued → completed is not a legal edge.
        const claimed = claim(
          "design-preview",
          (candidate) => candidate.id === run.id,
        );
        if (!claimed)
          throw new Problem(409, "This preview run can no longer resume");
        finish(
          claimed,
          "Preview approval accepted. This is a simulation; no review was posted.",
        );
      }
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
  messagesQueries.insert(
    db,
    message,
    run.owner_id,
    run.conversation_id,
    run.id,
    "assistant",
    content,
    JSON.stringify(
      MessageMetadata.parse({
        preview: true,
        ...(partial ? { partial: true } : {}),
      }),
    ),
    now(),
  );
  return message;
}

function finish(run: Run, content: string) {
  // Called inside the simulator's transaction: messages and delivery receipts commit together.
  new SteeringInbox(run).appendPending([]);
  const message = reply(run, content);
  const artifact = saveArtifact(run.owner_id, {
    title: run.input.slice(0, 120),
    content,
    agent: run.agent_id,
    conversation: run.conversation_id,
    run: run.id,
    folder: run.payload.folderId,
    metadata: { messageId: message, preview: true, model: MODEL },
    role: "answer",
  });
  agentCheckpointsQueries.previewComplete(
    db,
    run.id,
    message,
    artifact,
    "[]",
    content,
  );
  runsQueries.setResult(db, content, run.id);
  if (!transition(run, "completed", { preview: true }))
    throw new Problem(409, "This preview run can no longer complete");
  runsQueries.clearLease(db, run.id);
}

/** Seed once. A rebuild preserves edits and pairing rather than duplicating the fixture. */
export function seedDesignPreview() {
  if (!designPreview) throw new Error("Sample data requires a design preview");
  designPreviewSeedQueries.initialize(db);
  if (designPreviewSeedQueries.exists(db)) return;
  if (agentsQueries.any(db) || connectionsQueries.any(db))
    throw new Error("Design previews require a fresh sample workspace.");
  db.transaction(() => {
    const project = ensureWorkspaceProject(OWNER),
      connection = id();
    writeConnectionStatus(connection, () =>
      connectionsQueries.insertPreview(
        db,
        connection,
        OWNER,
        seal("preview-only-not-a-provider-key", OWNER),
        JSON.stringify(models),
        now(),
      ),
    );
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
    ] as const;
    scenarios.forEach(([state, title, content], index) => {
      const agent = agents[index],
        conversation = id(),
        runId = id(),
        time = now() - (index + 1) * 3600000;
      conversationsQueries.insertPreview(
        db,
        conversation,
        OWNER,
        agent.id,
        title,
        project,
        time,
      );
      runsQueries.insertPreview(db, {
        id: runId,
        owner: OWNER,
        agent: agent.id,
        conversation,
        input: title,
        // Completed fixtures still exercise the completion transition and hooks.
        state: state === "completed" ? "running" : state,
        payload: JSON.stringify({
          agentId: agent.id,
          connectionId: connection,
          provider: "openai",
          model: MODEL,
          folderId: project,
          previewFixture: true,
        }),
        error: state === "failed" ? content : null,
        time,
      });
      const run = parseRun(runsQueries.get(db, runId));
      const turns = index === 0 ? 24 : 1;
      for (let turn = 0; turn < turns; turn++) {
        messagesQueries.insertWithDefaultMetadata(
          db,
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
          messagesQueries.insert(
            db,
            id(),
            OWNER,
            conversation,
            runId,
            "assistant",
            content,
            JSON.stringify(
              MessageMetadata.parse({
                preview: true,
                partial: state === "running",
              }),
            ),
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
        approvalsQueries.insertPreview(
          db,
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
    designPreviewSeedQueries.insert(db);
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
    scheduled = setImmediate(() => {
      scheduled = undefined;
      tick();
    });
  };
  const reconcile = () => {
    const live = parseRuns(runsQueries.activePreviews(db, OWNER));
    const ids = new Set(live.map((run) => run.id));
    for (const [id, subscription] of watched)
      if (!ids.has(id)) {
        subscription.release();
        watched.delete(id);
      }
    for (const run of live)
      if (!watched.has(run.id)) {
        const subscription = watchRun(run);
        subscription.on("fallback", wake);
        watched.set(run.id, subscription);
      }
  };
  const tick = () => {
    db.transaction(() => {
      workerHealthQueries.previewHeartbeat(db, now());
      for (let i = 0; i < 10; i++) {
        // Use the ordinary queue's approval, pause and ordering barriers without dispatching work.
        const run = claim(
          "design-preview",
          (candidate) =>
            candidate.owner_id === OWNER &&
            candidate.kind === "agent" &&
            candidate.state === "queued" &&
            (!candidate.payload.previewFixture ||
              !!eventsQueries.previewQueued(db, OWNER, candidate.id)),
        );
        if (!run) break;
        finish(run, REPLY);
      }
      const steered = parseRuns(runsQueries.steeredPreviews(db, OWNER));
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
    }).immediate();
    reconcile();
  };
  const unsubscribe = changes.subscribe(OWNER, (events) => {
    if (
      events.some(
        ({ type }) =>
          [
            "queued",
            "running",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
            "steering.pending",
          ].includes(type) || type.startsWith("approval."),
      )
    )
      wake();
  });
  tick();
  // The simulation still advertises liveness without polling run/steering rows.
  const timer = setInterval(
    () => workerHealthQueries.previewHeartbeat(db, now()),
    5000,
  );
  return async () => {
    stopped = true;
    if (scheduled) clearImmediate(scheduled);
    unsubscribe();
    for (const subscription of watched.values()) subscription.release();
    clearInterval(timer);
    workerHealthQueries.removePreview(db);
  };
}
