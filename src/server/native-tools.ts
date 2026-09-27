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
import { readRunFile } from "./uploads.js";

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
const schemas = {
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
export function nativeBindings(run: Run): ToolBinding[] {
  const teamId = JSON.parse(run.payload).teamId;
  const team = teamId ? owned<any>("teams", teamId, run.owner_id) : null;
  const descriptions: Record<string, string> = {
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
): Promise<{ pending: string } | { result: any; artifactId: string }> {
  if (owned<Run>("runs", run.id, run.owner_id).state !== "running")
    throw new Problem(409, "Run is no longer executing");
  if (!nativeBindings(run).some((t) => t.tool === binding.tool))
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
  if (binding.tool === "loop_read_file") {
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
        const prior = db
          .prepare(
            "SELECT d.*,r.state,r.result,r.error,r.agent_id,r.id FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=? AND substr(d.call_id,1,?)=?",
          )
          .all(run.id, callId.length + 1, callId + ":") as any[];
        if (prior.length) return prior;
        if (owned<Run>("runs", run.id, run.owner_id).state !== "running")
          throw new Problem(409, "Manager is no longer running");
        return tasks.map((task, i) => {
          const child = submit(run.owner_id, {
            agentId: task.agentId,
            input: task.input,
            teamId,
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
  const result = { content: [{ type: "text", text }] };
  db.prepare(
    "UPDATE native_calls SET result=?,artifact_id=? WHERE run_id=? AND call_id=?",
  ).run(JSON.stringify(result), artifactId || null, run.id, callId);
  emit(run.owner_id, run.id, "tool.completed", {
    tool: binding.tool,
    artifactId,
  });
  return { result, artifactId };
}
