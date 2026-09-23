import Ajv from "ajv";
import { db, id, now, emit } from "../db.js";
import { owned, Problem } from "../domain.js";
import type { Run } from "../queue.js";
import { transition } from "../queue.js";
import { requestApproval } from "../approvals.js";
import { saveArtifact } from "../artifacts.js";
import { connect, readSecret, type MCPConnection } from "./client.js";
import { normalizeResult } from "./results.js";
const ajv = new Ajv({
  strict: false,
  allErrors: false,
  validateFormats: false,
});
export type ToolBinding = {
  name: string;
  connectionId: string;
  tool: string;
  description: string;
  inputSchema: any;
};
export function toolBindings(owner: string, agent: string): ToolBinding[] {
  const rows = db
    .prepare(
      "SELECT c.*,g.tool FROM grants g JOIN mcp_connections c ON c.id=g.connection_id AND c.owner_id=g.owner_id WHERE g.owner_id=? AND g.agent_id=? AND c.status='connected' ORDER BY c.id,g.tool",
    )
    .all(owner, agent) as any[];
  const result: ToolBinding[] = [];
  for (const row of rows) {
    const tool = JSON.parse(row.tools).find((t: any) => t.name === row.tool);
    if (tool)
      result.push({
        name: `loop_tool_${result.length}`,
        connectionId: row.id,
        tool: tool.name,
        description: `${row.name}: ${String(tool.description || tool.name).slice(0, 1500)}`,
        inputSchema: tool.inputSchema,
      });
  }
  return result.slice(0, 40);
}
export function authorizeTool(
  owner: string,
  agentId: string,
  connectionId: string,
  toolName: string,
  args: unknown,
) {
  owned("agents", agentId, owner);
  const c = owned<MCPConnection>("mcp_connections", connectionId, owner);
  if (c.status !== "connected")
    throw new Problem(409, "Tool connection is disabled or needs reconnecting");
  const grant = db
    .prepare(
      "SELECT * FROM grants WHERE owner_id=? AND agent_id=? AND connection_id=? AND tool=?",
    )
    .get(owner, agentId, connectionId, toolName) as any;
  if (!grant)
    throw new Problem(403, "This agent is not allowed to use this tool");
  const tool = JSON.parse(c.tools).find((t: any) => t.name === toolName);
  if (!tool) throw new Problem(404, "Tool is no longer available");
  if (
    JSON.stringify(args).length > 50000 ||
    JSON.stringify(tool.inputSchema).length > 50000
  )
    throw new Problem(400, "Tool input or schema is too large");
  let valid;
  try {
    valid = ajv.compile(tool.inputSchema)(args);
  } catch {
    throw new Problem(422, "Tool input schema is unsupported");
  }
  if (!valid)
    throw new Problem(422, "Tool arguments do not match the discovered schema");
  return { connection: c, tool, grant };
}
export async function invokeTool(
  run: Run,
  binding: ToolBinding,
  callId: string,
  args: Record<string, unknown>,
): Promise<{ pending: string } | { result: any; artifactId: string }> {
  if (!run.agent_id) throw new Problem(400, "Tool calls require an agent");
  const { connection, tool } = authorizeTool(
    run.owner_id,
    run.agent_id,
    binding.connectionId,
    binding.tool,
    args,
  );
  let invocation = db
    .prepare("SELECT * FROM tool_invocations WHERE run_id=? AND call_id=?")
    .get(run.id, callId) as any;
  if (
    invocation &&
    (invocation.connection_id !== connection.id ||
      invocation.tool !== binding.tool ||
      invocation.args !== JSON.stringify(args))
  )
    throw new Problem(409, "Tool call identity was reused for different input");
  if (invocation?.state === "completed")
    return {
      result: JSON.parse(invocation.result),
      artifactId: invocation.artifact_id,
    };
  if (invocation && ["executing", "unknown"].includes(invocation.state))
    throw new Problem(
      409,
      "The prior tool call has an uncertain external outcome. Inspect it before making a new request.",
    );
  // Every call requires approval in V0. Server-provided readOnlyHint is never permission authority.
  let approval = invocation?.approval_id
    ? owned<any>("approvals", invocation.approval_id, run.owner_id)
    : null;
  if (!approval) {
    approval = requestApproval(run, {
      type: "mcp_tool",
      connectionId: connection.id,
      server: connection.name,
      tool: binding.tool,
      arguments: args,
      message: `Allow @${JSON.parse(run.payload).name || "agent"} to call ${binding.tool} on ${connection.name}?`,
      callId,
    });
    const invocationId = id();
    db.prepare(
      "INSERT INTO tool_invocations(id,owner_id,run_id,connection_id,agent_id,call_id,tool,args,state,approval_id,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
    ).run(
      invocationId,
      run.owner_id,
      run.id,
      connection.id,
      run.agent_id,
      callId,
      binding.tool,
      JSON.stringify(args),
      approval.id,
      now(),
    );
    invocation = db
      .prepare("SELECT * FROM tool_invocations WHERE id=?")
      .get(invocationId);
  }
  if (approval.state === "pending") {
    transition(run, "awaiting_approval", { approvalId: approval.id });
    return { pending: approval.id };
  }
  if (approval.state !== "approved" || approval.expires_at < now())
    throw new Problem(403, "This tool approval is not valid");
  authorizeTool(
    run.owner_id,
    run.agent_id,
    binding.connectionId,
    binding.tool,
    args,
  );
  db.transaction(() => {
    const row = db
      .prepare(
        "UPDATE tool_invocations SET state='executing' WHERE id=? AND state='pending'",
      )
      .run(invocation.id);
    if (!row.changes) throw new Problem(409, "Tool execution already started");
    db.prepare(
      "UPDATE approvals SET state='executing' WHERE id=? AND state='approved'",
    ).run(approval.id);
  }).immediate();
  let client;
  try {
    client = await connect(connection);
    authorizeTool(
      run.owner_id,
      run.agent_id,
      binding.connectionId,
      binding.tool,
      args,
    );
    const live = owned<Run>("runs", run.id, run.owner_id);
    if (live.state !== "running")
      throw new Problem(409, "Run is no longer executing");
    let result: any = await client.callTool(
      { name: binding.tool, arguments: args },
      undefined,
      { timeout: 30000 },
    );
    if (result.isError)
      throw new Problem(422, "MCP server reported a tool error");
    let encoded = JSON.stringify(result);
    const secret = readSecret(connection),
      sensitive = [
        secret.token,
        secret.tokens?.access_token,
        secret.tokens?.refresh_token,
        ...Object.values(secret.headers || {}),
      ].filter((x): x is string => typeof x === "string" && x.length >= 8);
    for (const value of sensitive)
      encoded = encoded.split(value).join("[redacted]");
    if (encoded.length > 4 * 1024 * 1024)
      throw new Problem(413, "Tool result exceeds storage limit");
    result = JSON.parse(encoded);
    const metadata = JSON.parse(connection.metadata);
    const normalized = normalizeResult(result, {
      connectionId: connection.id,
      tool: binding.tool,
      fetchedAt: now(),
      fixture: metadata.fixture === true,
    });
    const resourceUri =
      tool._meta?.ui?.resourceUri || tool._meta?.["ui/resourceUri"];
    let appResource: any;
    if (typeof resourceUri === "string" && resourceUri.startsWith("ui://")) {
      try {
        const resource = await client.readResource(
          { uri: resourceUri },
          { timeout: 10000 },
        );
        const html = resource.contents.find(
          (r: any) =>
            r.mimeType === "text/html;profile=mcp-app" &&
            typeof r.text === "string",
        );
        if (html && String((html as any).text).length <= 1024 * 1024)
          appResource = {
            uri: resourceUri,
            html: sensitive.reduce(
              (text, value) => text.split(value).join("[redacted]"),
              String((html as any).text),
            ),
          };
      } catch {
        /* text/structured fallback remains available */
      }
    }
    const artifactId = db.transaction(() => {
      const artifactId = saveArtifact(run.owner_id, {
        ...normalized,
        agent: run.agent_id,
        conversation: run.conversation_id,
        run: run.id,
        folder: JSON.parse(run.payload).folderId,
        metadata: {
          connectionId: connection.id,
          tool: binding.tool,
          arguments: args,
          invocationId: invocation.id,
          fetchedAt: now(),
          appResource,
          toolResult: result,
          fixture: metadata.fixture === true,
        },
      });
      db.prepare(
        "UPDATE tool_invocations SET state='completed',result=?,artifact_id=? WHERE id=?",
      ).run(JSON.stringify(result), artifactId, invocation.id);
      db.prepare(
        "UPDATE approvals SET state='completed',result=? WHERE id=?",
      ).run(JSON.stringify({ artifactId }), approval.id);
      return artifactId;
    }).immediate();
    emit(run.owner_id, run.id, "tool.completed", {
      tool: binding.tool,
      artifactId,
    });
    return { result, artifactId };
  } catch (error) {
    db.prepare(
      "UPDATE tool_invocations SET state='unknown' WHERE id=? AND state='executing'",
    ).run(invocation.id);
    db.prepare(
      "UPDATE approvals SET state='unknown' WHERE id=? AND state='executing'",
    ).run(approval.id);
    if (error instanceof Problem) throw error;
    throw new Problem(
      422,
      "Tool call failed or timed out. Its external outcome is unknown; it will not be replayed.",
    );
  } finally {
    await client?.close().catch(() => {});
  }
}
