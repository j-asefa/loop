import { z } from "zod";
import { createHash } from "node:crypto";
import { db, now, emit } from "./db.js";
import { owned, Problem } from "./domain.js";
import { submit } from "./agent-runtime.js";
import { transition, type Run } from "./queue.js";
import { requestApproval } from "./approvals.js";
import { saveArtifact } from "./artifacts.js";
import type { ToolBinding } from "./mcp/broker.js";
import { installConfig, parseMcpConfig } from "./mcp/install.js";
import { connectionSelection } from "./hapi/contracts.js";
import { readRunFile } from "./uploads.js";
import { publishFileSchema, publishRunFile } from "./published-files.js";
import { applyActivity } from "./activities.js";
import { ACTIVITY_LIMITS } from "../agent-activities.js";

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
// how to call loop_plan; this says when, so providers that weigh system
// instructions over tool descriptions still publish plans. Added only when
// loop_plan is advertised, after the agent's own instructions, which are
// stored unchanged.
export const PLAN_GUIDANCE =
  "Loop plans: for any task with more than one step, call loop_plan with your plan before you start working, then call it again with the complete updated list each time a step starts or finishes. Keep step ids stable across updates and mark only the step you are working on as in_progress. The user sees this as a live checklist; Loop never infers a plan from your messages. Skip loop_plan for single-step answers.";
export function runtimeInstructions(
  instructions: string,
  bindings: Pick<ToolBinding, "tool" | "connectionId">[],
) {
  if (
    !bindings.some(
      (b) => b.tool === "loop_plan" && b.connectionId === "__loop__",
    )
  )
    return instructions;
  return instructions.trim()
    ? instructions + "\n\n" + PLAN_GUIDANCE
    : PLAN_GUIDANCE;
}
const schemas = {
  loop_publish_file: publishFileSchema,
  loop_plan: plan,
  loop_read_file: z.object({
    fileId: z.string().uuid(),
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().min(1).max(16384).default(12000),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
  loop_diagram: diagram,
  loop_install_mcp: install,
  loop_delegate: delegate,
};
export function nativeBindings(
  run: Run,
  options: { plans?: boolean } = {},
): ToolBinding[] {
  const teamId = JSON.parse(run.payload).teamId;
  const team = teamId ? owned<any>("teams", teamId, run.owner_id) : null;
  const descriptions: Record<string, string> = {
    loop_publish_file:
      "Publish a generated file to the user's Loop workspace. Use a path relative to your persistent workspace, or content for a small text/base64 file (use its filename as title). Copy files generated elsewhere into your workspace first. Hidden files, credentials, and files outside the workspace cannot be published. Files appear in the agent's Files tab and beside its result. Include the returned url in your answer; never claim a file is available until this tool succeeds. Publish generated images, documents, and mockups instead of leaving them on the worker.",
    ...(options.plans && {
      loop_plan:
        "Publish or update your plan for this task as a live checklist the user can follow. For multi-step work, publish the plan before starting and call this again with the complete updated list whenever a step starts or finishes. Keep each step's id stable and mark exactly the step you are working on as in_progress. Loop never infers a plan from your messages. It does not run anything and needs no approval.",
    }),
    loop_read_file:
      "Read an uploaded file attached to this conversation. Offsets and lengths are bytes; use nextOffset to continue. Use utf8 for text or base64 for binary files. Decode base64 locally before using native document/image tools. Reading attached files needs no additional approval.",
    loop_diagram:
      "Create a native Mermaid flowchart or diagram in Loop. No installation needed. Supply plain Mermaid source without HTML, click handlers or directives.",
    loop_install_mcp:
      "Install MCP servers for the whole Loop workspace from a JSON mcpServers configuration. Loop asks the user to approve installation, then makes the discovered tools available to all their agents. Tool calls follow the user's workspace approval preference. Supply JSON as config; never include secrets unless provided by the user.",
  };
  if (team?.manager_id === run.agent_id) {
    const workers = db
      .prepare(
        "SELECT a.id,a.name,substr(a.instructions,1,1000) AS instructions FROM team_members m JOIN agents a ON a.id=m.agent_id WHERE m.team_id=? AND a.owner_id=?",
      )
      .all(team.id, run.owner_id);
    descriptions.loop_delegate =
      "You manage this team. Delegate focused tasks to these workers using their agentId. Tasks run in parallel; results return here, and worker updates appear in the team feed. Synthesize their work for the user. Available workers: " +
      JSON.stringify(workers);
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
  // Only callers that advertised loop_plan (the API runtime) may invoke it.
  options: { plans?: boolean } = {},
): Promise<{ pending: string } | { result: any; artifactId: string }> {
  if (owned<Run>("runs", run.id, run.owner_id).state !== "running")
    throw new Problem(409, "Run is no longer executing");
  if (!nativeBindings(run, options).some((t) => t.tool === binding.tool))
    throw new Problem(403, "Native tool is unavailable to this agent");
  const args = schemas[binding.tool as keyof typeof schemas].parse(input);
  const encoded =
    binding.tool === "loop_install_mcp"
      ? createHash("sha256").update(JSON.stringify(args)).digest("hex")
      : JSON.stringify(args);
  const previous = db
    .prepare("SELECT * FROM native_calls WHERE run_id=? AND call_id=?")
    .get(run.id, callId) as any;
  if (
    previous &&
    (previous.tool !== binding.tool || previous.arguments !== encoded)
  )
    throw new Problem(409, "Tool call identity was reused");
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
  if (binding.tool === "loop_publish_file") {
    try {
      const published = await publishRunFile(
        run,
        callId,
        publishFileSchema.parse(args),
      );
      artifactId = published.artifactId;
      text = JSON.stringify(published);
    } catch (error) {
      if (owned<Run>("runs", run.id, run.owner_id).state !== "running")
        throw error;
      isError = true;
      text = "File was not published: " + (error as Error).message;
    }
  } else if (binding.tool === "loop_plan") {
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
        source: { transport: "api", origin: "loop_plan" },
        patch: { steps, explanation: p.explanation ?? null },
      },
    );
    if (!applied.applied && applied.reason !== "no change")
      throw new Problem(422, "Plan could not be saved: " + applied.reason);
    const done = steps.filter((s) => s.status === "completed").length;
    text = `Plan updated: ${done}/${steps.length} steps completed.`;
  } else if (binding.tool === "loop_read_file") {
    const file = schemas.loop_read_file.parse(args);
    text = JSON.stringify(
      readRunFile(run, file.fileId, file.offset, file.length, file.encoding),
    );
  } else if (binding.tool === "loop_diagram") {
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
            .get(run.id) as any
        )?.message_id,
      },
    });
    text = "Diagram saved and rendered natively: " + d.title;
  } else if (binding.tool === "loop_install_mcp") {
    const d = install.parse(args);
    parseMcpConfig(d.config); // Validate before asking for approval.
    let approval = previous?.approval_id
      ? owned<any>("approvals", previous.approval_id, run.owner_id)
      : null;
    if (!approval) {
      const preview = JSON.parse(d.config);
      for (const server of Object.values(preview.mcpServers) as any[]) {
        for (const field of ["env", "headers"])
          if (server[field])
            server[field] = Object.fromEntries(
              Object.keys(server[field]).map((key) => [key, "[provided]"]),
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
    const connection = owned<any>(
      "connections",
      JSON.parse(run.payload).connectionId,
      run.owner_id,
    );
    const installed = await installConfig(
      run.owner_id,
      d.config,
      run.agent_id!,
      run.id + ":" + callId,
      ["codex-app-server", "native-host"].includes(
        JSON.parse(connection.metadata).runtimeKind,
      )
        ? undefined
        : JSON.parse(connection.metadata).runtimeHostId,
    );
    text = JSON.stringify(installed);
    db.prepare(
      "UPDATE approvals SET state='completed',result=? WHERE id=?",
    ).run(text, approval.id);
  } else {
    const { tasks } = delegate.parse(args);
    const teamId = JSON.parse(run.payload).teamId;
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
          .all(run.id, callId.length + 1, callId + ":") as any[];
        if (prior.length) return prior;
        if (existing.n + tasks.length > 16)
          throw new Problem(
            400,
            "This manager run reached its 16-task delegation budget",
          );
        if (owned<Run>("runs", run.id, run.owner_id).state !== "running")
          throw new Problem(409, "Manager is no longer running");
        return tasks.map((task, i) => {
          const parent = JSON.parse(run.payload);
          if (parent.execution) {
            const worker = owned<any>("agents", task.agentId, run.owner_id);
            const selection = connectionSelection(
              owned<any>("connections", worker.connection_id, run.owner_id),
            );
            if (
              !selection ||
              selection.environmentId !== parent.execution.environmentId ||
              selection.billing.allowApiFallback !== false
            )
              throw new Problem(
                409,
                "Delegated work must preserve the environment and the selected provider’s native billing policy",
              );
          }
          const child = submit(run.owner_id, {
            agentId: task.agentId,
            input: task.input,
            teamId,
            folderId: parent.folderId,
            idempotencyKey: "delegate:" + run.id + ":" + callId + ":" + i,
          });
          db.prepare("INSERT INTO delegations VALUES(?,?,?,?)").run(
            run.id,
            callId + ":" + i,
            child.id,
            encoded,
          );
          return child;
        });
      })
      .immediate();
    if (
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
    text = JSON.stringify(
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
