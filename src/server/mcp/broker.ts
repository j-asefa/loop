import { MCP_TOOL_TIMEOUT_MS } from "./timeouts.js";
import {
  diagnosticText,
  errorFacts,
  errorSummary,
} from "../../../runtime/diagnostics.mjs";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { db, id, now, emit } from "../db.js";
import { owned, Problem } from "../domain.js";
import type { Run } from "../queue.js";
import { transition } from "../queue.js";
import { requestApproval } from "../approvals.js";
import { saveArtifact } from "../artifacts.js";
import { readSecret, type MCPConnection } from "./client.js";
import { normalizeResult, toolErrorMessage } from "./results.js";
import { connectForRun } from "./sessions.js";
import { redactCredentials } from "./redaction.js";
import { workspaceToolBindings, type ToolBinding } from "./tool-budget.js";
import { mcpApprovalMode } from "./approval-policy.js";
import { recordTrace } from "../traces.js";
export type { ToolBinding } from "./tool-budget.js";
const options = {
  strict: false,
  allErrors: false,
  validateFormats: false,
  // Tool schemas are supplied by independent servers and may reuse $id.
  addUsedSchema: false,
};
const validators = {
  legacy: new Ajv(options),
  "2019-09": new Ajv2019(options),
  "2020-12": new Ajv2020(options),
};
export function toolBindings(owner: string, agent: string): ToolBinding[] {
  owned("agents", agent, owner);
  return workspaceToolBindings(owner);
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
  const tool = JSON.parse(c.tools).find((t: any) => t.name === toolName);
  if (!tool) throw new Problem(404, "Tool is no longer available");
  if (
    JSON.stringify(args).length > 50000 ||
    JSON.stringify(tool.inputSchema).length > 50000
  )
    throw new Problem(400, "Tool input or schema is too large");
  let valid;
  try {
    const dialect = tool.inputSchema.$schema;
    const validator =
      !dialect || /\/draft\/2020-12\/schema#?$/.test(dialect)
        ? validators["2020-12"]
        : /\/draft\/2019-09\/schema#?$/.test(dialect)
          ? validators["2019-09"]
          : validators.legacy;
    valid = validator.compile(tool.inputSchema)(args);
  } catch {
    throw new Problem(422, "Tool input schema is unsupported");
  }
  if (!valid)
    throw new Problem(422, "Tool arguments do not match the discovered schema");
  return { connection: c, tool };
}
export async function invokeTool(
  run: Run,
  binding: ToolBinding,
  callId: string,
  args: Record<string, unknown>,
): Promise<{ pending: string } | { result: any; artifactId: string }> {
  if (!run.agent_id) throw new Problem(400, "Tool calls require an agent");
  const agentId = run.agent_id;
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
  if (invocation && ["completed", "failed"].includes(invocation.state))
    return {
      result: JSON.parse(invocation.result),
      artifactId: invocation.artifact_id,
    };
  if (invocation && ["executing", "unknown"].includes(invocation.state))
    throw new Problem(
      409,
      "The prior tool call has an uncertain external outcome. Inspect it before making a new request.",
    );
  // Serialize the policy read, approval creation and waiting transition with
  // preference updates in the API process. Either side must see the other.
  const approval = db
    .transaction(() => {
      // Permission comes from the owner's saved policy, never server-provided hints.
      const automaticallyAllowed = mcpApprovalMode(run.owner_id) === "allow";
      let approval = invocation?.approval_id
        ? owned<any>("approvals", invocation.approval_id, run.owner_id)
        : null;
      if (!approval) {
        approval = requestApproval(
          run,
          {
            type: "mcp_tool",
            connectionId: connection.id,
            server: connection.name,
            tool: binding.tool,
            arguments: args,
            message: `Allow @${JSON.parse(run.payload).name || "agent"} to call ${binding.tool} on ${connection.name}?`,
            callId,
          },
          automaticallyAllowed,
        );
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
      if (
        approval.state === "pending" &&
        automaticallyAllowed &&
        approval.expires_at > now()
      ) {
        const approved = db
          .prepare(
            "UPDATE approvals SET state='approved' WHERE id=? AND state='pending' AND expires_at>?",
          )
          .run(approval.id, now());
        approval = owned<any>("approvals", approval.id, run.owner_id);
        if (approved.changes)
          emit(run.owner_id, run.id, "approval.auto_approved", {
            approvalId: approval.id,
          });
      }
      if (approval.state === "pending") {
        recordTrace(run, "tool:" + callId, {
          kind: "tool",
          title: binding.tool,
          metadata: { state: "waiting" },
        });
        transition(run, "awaiting_approval", { approvalId: approval.id });
        return approval;
      }
      if (approval.state !== "approved" || approval.expires_at < now())
        throw new Problem(403, "This tool approval is not valid");
      authorizeTool(
        run.owner_id,
        agentId,
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
        if (!row.changes)
          throw new Problem(409, "Tool execution already started");
        db.prepare(
          "UPDATE approvals SET state='executing' WHERE id=? AND state='approved'",
        ).run(approval.id);
      }).immediate();
      return approval;
    })
    .immediate();
  if (approval.state === "pending") return { pending: approval.id };
  recordTrace(run, "tool:" + callId, {
    kind: "tool",
    title: binding.tool,
    metadata: { state: "running" },
  });
  let client;
  let phase = "connecting";
  const controller = new AbortController();
  const monitor = setInterval(() => {
    const live = db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as
      { state: string } | undefined;
    if (!live || ["cancelled", "interrupted"].includes(live.state))
      controller.abort();
  }, 500);
  const started = now();
  let received = false;
  try {
    client = await connectForRun(connection, run.id);
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
    phase = "calling";
    let result: any = await client.callTool(
      { name: binding.tool, arguments: args },
      undefined,
      { timeout: MCP_TOOL_TIMEOUT_MS, signal: controller.signal },
    );
    received = true;
    phase = "saving the result";
    const redact = (value: unknown) =>
      redactCredentials(value, [
        readSecret(connection),
        // OAuth may rotate credentials while a tool or app resource is fetched.
        readSecret(
          owned<MCPConnection>("mcp_connections", connection.id, run.owner_id),
        ),
      ]);
    const encoded = JSON.stringify(redact(result));
    if (encoded.length > 4 * 1024 * 1024)
      throw new Problem(413, "Tool result exceeds storage limit");
    result = JSON.parse(encoded);
    // A received MCP error lets the model correct its request. Unlike a lost
    // transport response, it has a known, durable result and is never replayed.
    const toolFailed = result.isError === true;
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
    if (
      !toolFailed &&
      typeof resourceUri === "string" &&
      resourceUri.startsWith("ui://")
    ) {
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
          appResource = redact({
            uri: resourceUri,
            html: String((html as any).text),
          });
      } catch {
        /* text/structured fallback remains available */
      }
    }
    const artifactId = db
      .transaction(() => {
        const artifactId = saveArtifact(run.owner_id, {
          ...normalized,
          agent: run.agent_id,
          conversation: run.conversation_id,
          run: run.id,
          folder: JSON.parse(run.payload).folderId,
          metadata: {
            messageId: (
              db
                .prepare(
                  "SELECT message_id FROM agent_checkpoints WHERE run_id=?",
                )
                .get(run.id) as any
            )?.message_id,
            connectionId: connection.id,
            tool: binding.tool,
            arguments: args,
            invocationId: invocation.id,
            fetchedAt: now(),
            appResource,
            toolResult: result,
            isError: toolFailed,
            fixture: metadata.fixture === true,
          },
        });
        db.prepare(
          "UPDATE tool_invocations SET state=?,result=?,artifact_id=? WHERE id=?",
        ).run(
          toolFailed ? "failed" : "completed",
          JSON.stringify(result),
          artifactId,
          invocation.id,
        );
        db.prepare(
          "UPDATE approvals SET state='completed',result=? WHERE id=?",
        ).run(JSON.stringify({ artifactId, isError: toolFailed }), approval.id);
        return artifactId;
      })
      .immediate();
    emit(run.owner_id, run.id, toolFailed ? "tool.failed" : "tool.completed", {
      tool: binding.tool,
      artifactId,
    });
    recordTrace(run, "tool:" + callId, {
      kind: "tool",
      title: binding.tool,
      artifactId,
      content: toolFailed ? toolErrorMessage(result) : "",
      metadata: {
        state: toolFailed ? "failed" : "completed",
        isError: toolFailed,
      },
    });
    return { result, artifactId };
  } catch (error) {
    const elapsedMs = now() - started;
    const facts = {
      ...errorFacts(error),
      ...(error instanceof Problem ? error.diagnostic : {}),
    };
    let cause = errorSummary(error, [], false);
    try {
      const secrets = [
        readSecret(connection),
        readSecret(
          owned<MCPConnection>("mcp_connections", connection.id, run.owner_id),
        ),
      ];
      cause = diagnosticText(
        redactCredentials(
          (error as Error)?.message || "No error message was returned",
          secrets,
        ),
      );
    } catch {
      // A removed or unreadable connection must not hide the original failure.
      // Without its credentials, retain only the error's class and code.
    }
    const outcome = received
      ? "received"
      : phase === "connecting"
        ? "not_sent"
        : "unknown";
    const message = `${connection.name} · ${binding.tool} failed while ${phase} after ${Math.ceil(elapsedMs / 1000)}s: ${cause}${outcome === "unknown" ? " Its external outcome is unknown; it will not be replayed." : outcome === "received" ? " The tool responded, but Loop could not save the result. The call will not be replayed." : " The tool request was not sent."}`;
    const failure = {
      phase,
      server: connection.name,
      tool: binding.tool,
      elapsedMs,
      outcome,
      ...facts,
    };
    recordTrace(run, "tool:" + callId, {
      kind: "tool",
      title: binding.tool,
      content: message,
      metadata: { state: "failed", isError: true, failure },
    });
    db.prepare(
      "UPDATE tool_invocations SET state='unknown',result=? WHERE id=? AND state='executing'",
    ).run(
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text: message }],
        failure,
      }),
      invocation.id,
    );
    db.prepare(
      "UPDATE approvals SET state='unknown',result=? WHERE id=? AND state='executing'",
    ).run(JSON.stringify({ error: message, failure }), approval.id);
    throw new Problem(
      error instanceof Problem ? error.status : 422,
      message,
      failure,
    );
  } finally {
    clearInterval(monitor);
    if (JSON.parse(connection.metadata).transport !== "stdio")
      await client?.close().catch(() => {});
  }
}
