import type { QueryRow } from "./query-records.js";
import { agentPayload } from "./row-schemas.js";
import {
  assertFleetEffect,
  inheritFleetEffect,
} from "./fleet-effect-authorizations.js";

import { z } from "zod";
import {
  reviewReadSchema,
  readReview,
  requestReviewSchema,
  reviewStatusSchema,
} from "./review-access.js";
import {
  messageSchema,
  directorySchema,
  statusSchema,
} from "./agent-mail-schema.js";
import { memberRole } from "./agent-mail-policy.js";
import { createHash } from "node:crypto";
import { db, now, emit } from "./db.js";
import { ownedApproval, ownedConnection, ownedRun, Problem } from "./domain.js";
import { submit } from "./agent-runtime.js";
import { transition, type Run } from "./queue.js";
import { requestApproval } from "./approvals.js";
import { saveArtifact } from "./artifacts.js";
import type { ToolBinding } from "./mcp/broker.js";
import { installConfig, parseMcpConfig } from "./mcp/install.js";
import { readRunFile } from "./uploads.js";
import { agentFeedAccess, feedForAgent } from "./news.js";
import { publishFileSchema, publishRunFile } from "./published-files.js";
import { PublishReply } from "../shared/steering-replies.js";
import { publishReply } from "./steering-replies.js";
import { applyActivity } from "./activities.js";
import {
  requestableReviewTeams,
  requestReview,
  requestedReviewStatus,
} from "./code-reviews.js";
import {
  MAIL_LIMITS,
  discoverMailAgents,
  mailStatus,
  sendMail,
  teamOf,
  teamRoster,
} from "./agent-mail.js";
import { ACTIVITY_LIMITS } from "../agent-activities.js";
import {
  GITHUB_GUIDANCE,
  githubContext,
  parsePullRequestUrls,
} from "../shared/github.js";

const diagram = z.object({
  title: z.string().min(1).max(180),
  source: z.string().min(1).max(30000),
});
const install = z.object({ config: z.string().min(1).max(50000) });
const delegate = z.object({
  tasks: z
    .array(
      z.object({
        agentId: z.string(),
        input: z.string().trim().min(1).max(12000),
      }),
    )
    .min(1)
    .max(8),
  // Optional, not defaulted: a resumed call must keep its original identity.
  wait: z.boolean().optional(),
});
// Structured plans for API-provider runs. Display-only: a plan never grants
// or runs anything. Native harnesses publish their own plans instead.
const plan = z.object({
  explanation: z.string().max(2000).optional(),
  steps: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[A-Za-z0-9_.:-]{1,80}$/)
          .optional()
          .describe("Stable step identifier; keep it across plan updates."),
        title: z.string().trim().min(1).max(500),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      }),
    )
    .min(1)
    .max(ACTIVITY_LIMITS.steps),
});
// Agent-facing plan guidance for API-provider runs. The tool description says
// how to call loop55_plan; this says when, so providers that weigh system
// instructions over tool descriptions still publish plans. Added only when
// loop55_plan is advertised, after the agent's own instructions, which are
// stored unchanged.
export const PLAN_GUIDANCE =
  "Loop55 plans: for any task with more than one step, call loop55_plan with your plan before you start working, then call it again with the complete updated list each time a step starts or finishes. Keep step ids stable across updates and mark only the step you are working on as in_progress. The user sees this as a live checklist; Loop55 never infers a plan from your messages. Skip loop55_plan for single-step answers.";
export function runtimeInstructions(
  instructions: string,
  bindings: Pick<ToolBinding, "tool" | "connectionId">[],
  latestMessage = "",
) {
  const plans = bindings.some(
    (b) => b.tool === "loop55_plan" && b.connectionId === "__loop__",
  );
  // Tool names only select guidance; the broker enforces GitHub rules.
  const github = bindings.some(
    (b) => b.connectionId !== "__loop__" && b.tool === "pull_request_read",
  );
  const added = [
    plans ? PLAN_GUIDANCE : "",
    github ? GITHUB_GUIDANCE : "",
    github ? githubContext(parsePullRequestUrls(latestMessage)) : "",
  ].filter(Boolean);
  if (!added.length) return instructions;
  return [instructions.trim() ? instructions : "", ...added]
    .filter(Boolean)
    .join("\n\n");
}
const handoff = z.object({
  to: z.string().min(1).max(200),
  task: z.string().trim().min(1).max(3000),
  context: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    .describe(
      "Decisions, completed work, remaining steps and relevant conversation excerpts.",
    ),
  workspace: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Repository, branch/commit and working directory. Say whether uncommitted changes are shared, committed or published.",
    ),
  fileIds: z.array(z.string().uuid()).max(8).default([]),
  threadId: z.string().max(200).optional(),
  scope: messageSchema.shape.scope,
  conversationId: messageSchema.shape.conversationId,
});
const schemas = {
  loop55_reply: PublishReply,
  loop55_handoff: handoff,
  loop55_review_read: reviewReadSchema,
  loop55_publish_file: publishFileSchema,
  loop55_plan: plan,
  loop55_read_file: z.object({
    fileId: z.string().uuid(),
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().min(1).max(16384).default(12000),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
  loop55_diagram: diagram,
  loop55_feed: z.object({
    feedId: z.string().max(120).optional(),
    query: z.string().max(200).optional(),
    unreadOnly: z.boolean().default(false),
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  loop55_install_mcp: install,
  loop55_delegate: delegate,
  loop55_agents: directorySchema,
  loop55_message: messageSchema,
  loop55_message_status: statusSchema,
  loop55_request_review: requestReviewSchema,
  loop55_review_status: reviewStatusSchema,
};
export function nativeBindings(
  run: Run,
  options: { plans?: boolean } = {},
): ToolBinding[] {
  if (run.payload.reviewId)
    return [
      {
        name: "loop55_review_read",
        tool: "loop55_review_read",
        connectionId: "__loop__",
        description:
          "Read immutable captured repository context for this review. Omit path to list files, changed paths and omissions (offset paginates the list). Supply path to read text; version before reads the baseline of a changed file. Text offsets are character offsets; use nextOffset to continue. This tool cannot read live files, execute commands or edit anything.",
        inputSchema: z.toJSONSchema(reviewReadSchema),
      },
    ];
  const team = teamOf(run);
  const descriptions: Record<string, string> = {
    loop55_reply:
      "Publish a complete reply to a user message received while this task is running. Use the message ID from Loop55's steering wrapper as replyTo and your answer as body. The reply appears in the user's Replies tab and remains until they archive it. Each call publishes a separate reply; ordinary text does not. Keep working on the task after replying unless the user redirects or stops it. Use your normal final answer for the task's result and loop55_message for agent mail.",
    loop55_publish_file:
      "Publish a generated file to the user's Loop55 workspace. Use a path relative to your persistent workspace, or content for a small text/base64 file (use its filename as title). Copy files generated elsewhere into your workspace first. Hidden files, credentials, and files outside the workspace cannot be published. Files can be up to 25 MB; make larger ones smaller first, for example by compressing or splitting them. Files appear under Your profile > Files, in the agent's Files tab, and beside its result. Include the returned url in your answer; never claim a file is available until this tool succeeds. Publish generated images, documents, and mockups instead of leaving them on the worker.",
    ...(options.plans && {
      loop55_plan:
        "Publish or update your plan for this task as a live checklist the user can follow. For multi-step work, publish the plan before starting and call this again with the complete updated list whenever a step starts or finishes. Keep each step's id stable and mark exactly the step you are working on as in_progress. Loop55 never infers a plan from your messages. It does not run anything and needs no approval.",
    }),
    loop55_read_file:
      "Read an uploaded file attached to this conversation. Offsets and lengths are bytes; use nextOffset to continue. Use utf8 for text or base64 for binary files. Decode base64 locally before using native document/image tools. Reading attached files needs no additional approval.",
    loop55_diagram:
      "Create a native Mermaid flowchart or diagram in Loop55. No installation needed. Supply plain Mermaid source without HTML, click handlers or directives.",
    ...(agentFeedAccess(run.owner_id) && {
      loop55_feed:
        "Read the public feeds the user follows in Loop55's Social tab: headlines, excerpts, links and discussion links, newest first. Use it when the user asks what is new, to find a story they half-remember, or to summarize what they have not read. Filter with feedId, query, since or unreadOnly. It reads only the feeds they already follow and only what Loop55 has already read, so say what it is as of; it fetches nothing, marks nothing read, and needs no approval.",
    }),
    loop55_install_mcp:
      "Install MCP servers for the whole Loop55 workspace from a JSON mcpServers configuration. Loop55 asks the user to approve installation, then makes the discovered tools available to all their agents. Tool calls follow the user's workspace approval preference. Supply JSON as config; never include secrets unless provided by the user.",
  };
  descriptions.loop55_review_status =
    "Read the status and consolidated report of reviews requested by this agent, including earlier turns. Pass reviewId, or omit it to recover the ten most recent requests after a timeout. Running is not approval. Check later without busy-waiting; never start a duplicate review just to retrieve its result.";
  const reviewTeams = run.agent_id
    ? requestableReviewTeams(run.owner_id, run.agent_id)
    : [];
  if (reviewTeams.length)
    descriptions.loop55_request_review =
      "Ask a code review team to review your changes, for example before you open a pull request. Loop55 captures an immutable snapshot of your working checkout (scope branch: commits since base; uncommitted: working-tree changes including new files; staged: the index), three reviewers examine it independently and the team lead consolidates their findings. By default this call returns a reviewId immediately; use loop55_review_status later to retrieve the consolidated report. Optional wait:true blocks until completion and may exceed your harness timeout; recover with loop55_review_status if it does. Edits made after the capture are not reviewed; fix confirmed findings, then request another review if needed. The review never edits files, runs tests or opens a pull request. Review teams: " +
      JSON.stringify(reviewTeams);
  if (team?.manager_id === run.agent_id) {
    const workers = db
      .prepare(
        "SELECT a.id,a.name,substr(a.instructions,1,1000) AS instructions FROM team_members m JOIN agents a ON a.id=m.agent_id WHERE m.team_id=? AND a.owner_id=? AND a.retired_at IS NULL",
      )
      .all(team.id, run.owner_id);
    descriptions.loop55_delegate =
      "You manage this team. Delegate focused tasks to these workers using their agentId. Tasks run in parallel; results return here, and worker updates appear in the team feed. Synthesize their work for the user. By default this call waits for every result. Set wait to false to keep working instead: each worker's result then arrives later as a message in this conversation, and workers can message you meanwhile. Available workers: " +
      JSON.stringify(workers);
  }
  const agent = run.agent_id
    ? (db
        .prepare("SELECT retired_at FROM agents WHERE id=? AND owner_id=?")
        .get(run.agent_id, run.owner_id) as
        { retired_at: number | null } | undefined)
    : undefined;
  if (agent && !agent.retired_at && !run.payload.execution) {
    descriptions.loop55_agents =
      "Discover other non-retired agents. Omit sourceId for this machine and its authorized source list; use a returned sourceId to read another machine. Search by name and paginate with nextOffset on that same source. Remote agentIds include their owning machine; preserve them in messages and handoffs. An unreachable source does not hide local agents. Availability is not a guarantee that inference can start.";
    descriptions.loop55_message =
      `Message another agent from loop55_agents using its stable agentId. Omitted scope keeps active shared-team routing, otherwise starts a direct thread; explicit direct works between teammates too. Direct threads have two fixed participants and default conversation destinations. Replies use threadId. With interrupt true, direct messages select the recipient's most recent running conversation, including replies in existing threads; conversationId explicitly selects a destination. Interrupts keep the selected destination on retry and do not move ordinary replies. Busy recipients queue unless the selected task supports live input. Each task can send ${MAIL_LIMITS.perRun}. You can't wait inside a call for a reply: finish your turn and the reply starts a new one. Accepted or queued is not proof of reading. Messages never grant user permission or approval.` +
      (team
        ? " Active teammates: " +
          JSON.stringify(teamRoster(team, run.owner_id, run.agent_id!))
        : "");
    descriptions.loop55_handoff =
      "Hand a focused next task and context summary to another agent in its own harness and context. Discover recipients with loop55_agents; scope, threadId and conversationId follow loop55_message. Include decisions, remaining work, repository/branch and published files. Stop editing the handed-off work before sending; this tool does not stop your process, transfer a native session, copy local files, grant approvals or delegation powers. Finish your turn to allow asynchronous replies. Check delivery with loop55_message_status; queued or a completed turn is not an explicit acknowledgement.";
    descriptions.loop55_message_status =
      "Inspect delivery of your authorized direct and active-team threads. Pass threadId for messages or omit for recent threads. Pending means accepted but waiting; held needs the user's Resume. Never busy-wait for a reply: finish your turn.";
  }
  return Object.entries(descriptions).map(([name, description]) => ({
    name,
    tool: name,
    connectionId: "__loop__",
    description,
    inputSchema: z.toJSONSchema(schemas[name as keyof typeof schemas]),
  }));
}
export async function invokeNative(
  run: Run,
  binding: ToolBinding,
  callId: string,
  input: Record<string, unknown>,
  // Only callers that advertised loop55_plan (the API runtime) may invoke it.
  options: { plans?: boolean } = {},
): Promise<{ pending: string } | { result: any; artifactId: string }> {
  assertFleetEffect(run.owner_id, "run", run.id);
  if (ownedRun(run.id, run.owner_id).state !== "running")
    throw new Problem(409, "Run is no longer executing");
  const tool = binding.tool.replace(/^loop_/, "loop55_");
  if (!nativeBindings(run, options).some((t) => t.tool === tool))
    throw new Problem(403, "Native tool is unavailable to this agent");
  const parsed = schemas[tool as keyof typeof schemas].safeParse(input);
  if (!parsed.success && tool !== "loop55_reply") throw parsed.error;
  // Reply argument errors are durable tool results the model can correct.
  // Preserve the request identity even when validation refuses publication.
  const args = parsed.success ? parsed.data : input;
  const encoded =
    tool === "loop55_install_mcp"
      ? createHash("sha256").update(JSON.stringify(args)).digest("hex")
      : JSON.stringify(args);
  const previous = db
    .prepare("SELECT * FROM native_calls WHERE run_id=? AND call_id=?")
    .get(run.id, callId) as QueryRow<"native_calls"> | undefined;
  if (
    previous &&
    (previous.tool !== binding.tool || previous.arguments !== encoded)
  ) {
    throw new Problem(409, "Tool call identity was reused");
  }
  if (previous?.result)
    return {
      result: JSON.parse(previous.result),
      artifactId: previous.artifact_id || "",
    };
  db.prepare(
    "INSERT OR IGNORE INTO native_calls(run_id,call_id,tool,arguments) VALUES(?,?,?,?)",
  ).run(run.id, callId, binding.tool, encoded);
  let text: string,
    artifactId = "";
  let isError = false;
  if (tool === "loop55_reply") {
    try {
      if (!parsed.success) throw parsed.error;
      text = JSON.stringify(publishReply(run, callId, args));
    } catch (error) {
      if (
        !(
          error instanceof z.ZodError ||
          (error instanceof Problem && error.status === 404)
        ) ||
        ownedRun(run.id, run.owner_id).state !== "running"
      )
        throw error;
      isError = true;
      text =
        "Reply was not published: " +
        (error instanceof z.ZodError
          ? "Supply the steered message ID as replyTo and a nonempty body (at most 30,000 characters)."
          : error.message) +
        " Correct the arguments and call loop55_reply again.";
    }
  } else if (tool === "loop55_publish_file") {
    try {
      const published = await publishRunFile(
        run,
        callId,
        publishFileSchema.parse(args),
      );
      artifactId = published.artifactId;
      text = JSON.stringify(published);
    } catch (error) {
      if (ownedRun(run.id, run.owner_id).state !== "running") throw error;
      isError = true;
      text = "File was not published: " + (error as Error).message;
    }
  } else if (tool === "loop55_plan") {
    const p = plan.parse(args);
    const ids = new Set<string>();
    const steps = p.steps.map((step, i) => {
      if (step.id && ids.has(step.id))
        throw new Problem(400, "Plan step ids must be unique");
      if (step.id) ids.add(step.id);
      return step.id
        ? { id: step.id, title: step.title, status: step.status }
        : {
            id: `step-${i}`,
            positional: true,
            title: step.title,
            status: step.status,
          };
    });
    const applied = applyActivity(
      {
        owner: run.owner_id,
        conversation: run.conversation_id,
        run: run.id,
      },
      {
        v: 1,
        kind: "plan",
        id: "plan",
        source: { transport: "api", origin: "loop55_plan" },
        patch: { steps, explanation: p.explanation ?? null },
      },
    );
    if (!applied.applied && applied.reason !== "no change")
      throw new Problem(422, "Plan could not be saved: " + applied.reason);
    const done = steps.filter((s) => s.status === "completed").length;
    text = `Plan updated: ${done}/${steps.length} steps completed.`;
  } else if (tool === "loop55_feed") {
    text = JSON.stringify(
      feedForAgent(run.owner_id, schemas.loop55_feed.parse(args)),
    );
  } else if (tool === "loop55_read_file") {
    const file = schemas.loop55_read_file.parse(args);
    text = JSON.stringify(
      readRunFile(run, file.fileId, file.offset, file.length, file.encoding),
    );
  } else if (tool === "loop55_diagram") {
    const d = diagram.parse(args);
    if (/%%\{|\bclick\s|<\/?[a-z]/i.test(d.source))
      throw new Problem(400, "Use plain, noninteractive Mermaid source");
    artifactId = saveArtifact(run.owner_id, {
      title: d.title,
      content: d.source,
      kind: "diagram",
      agent: run.agent_id,
      conversation: run.conversation_id,
      run: run.id,
      metadata: {
        native: true,
        messageId: (
          db
            .prepare("SELECT message_id FROM agent_checkpoints WHERE run_id=?")
            .get(run.id) as QueryRow<"agent_checkpoints"> | undefined
        )?.message_id,
      },
    });
    text = "Diagram saved and rendered natively: " + d.title;
  } else if (tool === "loop55_install_mcp") {
    const d = install.parse(args);
    parseMcpConfig(d.config); // Validate before asking for approval.
    let approval = previous?.approval_id
      ? ownedApproval(previous.approval_id, run.owner_id)
      : null;
    if (!approval) {
      const preview = {
        mcpServers: Object.fromEntries(parseMcpConfig(d.config)),
      };
      for (const server of Object.values(preview.mcpServers)) {
        if ("env" in server)
          server.env = Object.fromEntries(
            Object.keys(server.env).map((key) => [key, "[provided]"]),
          );
        if ("headers" in server && server.headers)
          server.headers = Object.fromEntries(
            Object.keys(server.headers).map((key) => [key, "[provided]"]),
          );
      }
      approval = requestApproval(run, {
        type: "mcp_install",
        config: preview,
        digest: encoded,
        agentId: run.agent_id,
        message:
          "Install these MCP servers for all agents in your workspace? Tool calls will follow your workspace approval preference.",
      });
      db.prepare(
        "UPDATE native_calls SET approval_id=? WHERE run_id=? AND call_id=?",
      ).run(approval.id, run.id, callId);
    }
    if (approval.state === "pending") {
      transition(run, "awaiting_approval", { approvalId: approval.id });
      return { pending: approval.id };
    }
    if (approval.state !== "approved" || approval.expires_at < now())
      throw new Problem(403, "Installation approval is no longer valid");
    const connection = ownedConnection(
      agentPayload(run).connectionId,
      run.owner_id,
    );
    const installed = await installConfig(
      run.owner_id,
      d.config,
      run.agent_id!,
      run.id + ":" + callId,
      ["codex-app-server", "native-host"].includes(
        connection.metadata.runtimeKind || "",
      )
        ? undefined
        : connection.metadata.runtimeHostId,
    );
    text = JSON.stringify(installed);
    db.prepare(
      "UPDATE approvals SET state='completed',result=? WHERE id=?",
    ).run(text, approval.id);
  } else if (
    tool === "loop55_agents" ||
    tool === "loop55_message" ||
    tool === "loop55_message_status" ||
    tool === "loop55_handoff"
  ) {
    try {
      text = JSON.stringify(
        tool === "loop55_handoff"
          ? (() => {
              const transfer = handoff.parse(args);
              // Keep the wording (and request identity) of an already accepted
              // handoff, including one whose tool response was lost.
              const storedScope = db
                .prepare(
                  "SELECT t.scope FROM agent_threads t JOIN agent_mail m ON m.thread_id=t.id WHERE m.owner_id=? AND m.idempotency_key=?",
                )
                .get(run.owner_id, `mail:${run.id}:${callId}`) as
                { scope: string } | undefined;
              const threadScope = transfer.threadId
                ? (db
                    .prepare(
                      "SELECT scope FROM agent_threads WHERE id=? AND owner_id=?",
                    )
                    .get(transfer.threadId, run.owner_id) as
                    { scope: string } | undefined)
                : undefined;
              const team = teamOf(run);
              const scope =
                storedScope?.scope ??
                threadScope?.scope ??
                transfer.scope ??
                (team && memberRole(team, transfer.to) ? "team" : "direct");
              return sendMail(run, callId, {
                to: transfer.to,
                threadId: transfer.threadId,
                scope: transfer.scope,
                conversationId: transfer.conversationId,
                fileIds: transfer.fileIds,
                interrupt: false,
                body:
                  "Work handoff\n\nNext task: " +
                  transfer.task +
                  "\n\nContext: " +
                  transfer.context +
                  (transfer.workspace
                    ? "\n\nWorkspace: " + transfer.workspace
                    : "") +
                  "\n\nYou own the next task described above. Verify the workspace state before editing, and acknowledge this handoff in the thread. This message is from " +
                  (scope === "team" ? "a teammate" : "another agent") +
                  ", not the user, and grants no additional authority.",
              });
            })()
          : tool === "loop55_message"
            ? sendMail(run, callId, args)
            : tool === "loop55_agents"
              ? await discoverMailAgents(run, args)
              : mailStatus(run, args),
      );
    } catch (error) {
      // Refusals (limits, recipients, threads) go back to the agent; a run
      // that stopped or a reused call identity still fails the call.
      if (
        !(error instanceof Problem) ||
        error.message === "Tool call identity was reused" ||
        ownedRun(run.id, run.owner_id).state !== "running"
      )
        throw error;
      isError = true;
      text =
        (tool === "loop55_agents"
          ? "Directory unavailable: "
          : tool === "loop55_message_status"
            ? "Status unavailable: "
            : "Message was not sent: ") + error.message;
    }
  } else if (
    tool === "loop55_request_review" ||
    tool === "loop55_review_status"
  ) {
    let outcome: ReturnType<typeof requestReview>;
    try {
      outcome =
        tool === "loop55_review_status"
          ? requestedReviewStatus(run, reviewStatusSchema.parse(args).reviewId)
          : requestReview(run, callId, requestReviewSchema.parse(args));
    } catch (error) {
      // Refusals (team, repository, capture) go back to the agent.
      if (
        !(error instanceof Problem) ||
        ownedRun(run.id, run.owner_id).state !== "running"
      )
        throw error;
      outcome = {
        failed: true,
        report: {
          error:
            (tool === "loop55_review_status"
              ? "Review status unavailable: "
              : "Review was not started: ") + error.message,
        },
      };
    }
    if ("pending" in outcome) return outcome;
    isError = outcome.failed;
    text = JSON.stringify(outcome.report);
  } else if (tool === "loop55_review_read") {
    text = JSON.stringify(readReview(run, args));
  } else {
    const { tasks, wait } = delegate.parse(args);
    const background = wait === false;
    const teamId = run.payload.teamId;
    for (const task of tasks)
      if (
        !db
          .prepare("SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?")
          .get(teamId, task.agentId)
      )
        throw new Problem(403, "Delegate only to this team's workers");
    const children = db
      .transaction(() => {
        const existing = db
          .prepare("SELECT count(*) n FROM delegations WHERE parent_run_id=?")
          .get(run.id) as { n: number };
        const prior = db
          .prepare(
            "SELECT d.*,r.state,r.result,r.error,r.agent_id,r.id FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? AND substr(d.call_id,1,?)=?",
          )
          .all(
            run.id,
            callId.length + 1,
            callId + ":",
          ) as (QueryRow<"delegations"> &
          Pick<Run, "state" | "result" | "error" | "agent_id" | "id">)[];
        if (prior.length) return prior;
        if (existing.n + tasks.length > 16)
          throw new Problem(
            400,
            "This manager run reached its 16-task delegation budget",
          );
        if (ownedRun(run.id, run.owner_id).state !== "running")
          throw new Problem(409, "Manager is no longer running");
        return tasks.map((task, i) => {
          const parent = run.payload;
          const child = submit(run.owner_id, {
            agentId: task.agentId,
            input: task.input,
            teamId,
            folderId: parent.folderId,
            idempotencyKey: "delegate:" + run.id + ":" + callId + ":" + i,
          });
          inheritFleetEffect(run.owner_id, "run", run.id, child.id);
          db.prepare(
            "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments,background) VALUES(?,?,?,?,?)",
          ).run(
            run.id,
            callId + ":" + i,
            child.id,
            encoded,
            background ? 1 : 0,
          );
          return child;
        });
      })
      .immediate();
    if (
      !background &&
      children.some((c) =>
        [
          "queued",
          "running",
          "pausing",
          "paused",
          "awaiting_approval",
          "waiting_children",
        ].includes(c.state),
      )
    ) {
      return { pending: callId };
    }
    text = background
      ? JSON.stringify({
          delegated: children.map((c) => ({
            agentId: c.agent_id,
            runId: c.id,
            state: c.state,
          })),
          note: "Running in the background. Each worker's result arrives later as a message in this conversation. Keep working or finish your turn; don't wait in a loop.",
        })
      : JSON.stringify(
          children.map((c) => ({
            agentId: c.agent_id,
            state: c.state,
            result: (c.result || "").slice(0, 16000),
            error: c.error,
          })),
        );
  }
  const result = {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
  db.prepare(
    "UPDATE native_calls SET result=?,artifact_id=? WHERE run_id=? AND call_id=?",
  ).run(JSON.stringify(result), artifactId || null, run.id, callId);
  emit(run.owner_id, run.id, "tool.completed", {
    tool: binding.tool,
    artifactId,
  });
  return { result, artifactId };
}
