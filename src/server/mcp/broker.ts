import * as toolInvocationsQueries from "../sql/tool-invocations.js";
import * as approvalsQueries from "../sql/approvals.js";
import * as agentCheckpointsQueries from "../sql/agent-checkpoints.js";
import { QueryRecords, type QueryRow } from "../query-records.js";

import { watchRun } from "../run-signal.js";
import { assertFleetEffect } from "../fleet-effect-authorizations.js";
import { MCP_TOOL_TIMEOUT_MS } from "./timeouts.js";
import {
  diagnosticText,
  errorFacts,
  errorSummary,
} from "../../../runtime/diagnostics.ts";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { db, id, now, emit } from "../db.js";
import {
  ownedAgent,
  ownedMcpConnection,
  ownedApproval,
  ownedRun,
  Problem,
} from "../domain.js";
import { type Run, transition } from "../queue.js";

import { requestApproval } from "../approvals.js";
import { saveArtifact } from "../artifacts.js";
import { readSecret, type MCPConnection } from "./client.js";
import { normalizeResult, toolErrorMessage } from "./results.js";
import { connectForRun } from "./sessions.js";
import { redactCredentials } from "./redaction.js";
import { workspaceToolBindings, type ToolBinding } from "./tool-budget.js";
import { mcpApprovalMode } from "./approval-policy.js";
import { recordTrace } from "../traces.js";
import {
  createdPullRequest,
  isGithubMcpUrl,
  mergeHeadProblem,
} from "../../shared/github.js";
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
  ownedAgent(agent, owner);
  return workspaceToolBindings(owner);
}
export function authorizeTool(
  owner: string,
  agentId: string,
  connectionId: string,
  toolName: string,
  args: unknown,
) {
  ownedAgent(agentId, owner);
  return authorizeConnectionTool(owner, connectionId, toolName, args);
}
/** Validate a source-owned MCP call made through a delegated peer token. */
export function authorizeConnectionTool(
  owner: string,
  connectionId: string,
  toolName: string,
  args: unknown,
) {
  const c = ownedMcpConnection(connectionId, owner);
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
  const hints = loop55Hints(c, tool);
  const merge =
    (isGithubMcpUrl(c.url) || hints.github) &&
    mergeHeadProblem(hints.sourceTool || toolName, args);
  if (merge) throw new Problem(422, merge);
  return { connection: c, tool, hints };
}
// Loop55's own `_meta.loop55` hints on a discovered tool. Only a federation
// connection (another Loop55 source relaying its tools) may rename a tool in
// the approval prompt or claim GitHub provenance; any other server's hints
// could disguise an effect. `alwaysAsk` only makes approval stricter, so it
// is honoured from any server.
export function loop55Hints(
  connection: Pick<MCPConnection, "metadata">,
  tool: any,
) {
  let federated = false;
  try {
    federated =
      JSON.parse(connection.metadata || "{}").transport === "federation";
  } catch {
    // Unreadable metadata grants no hints.
  }
  const loop = tool?._meta?.loop55 ?? tool?._meta?.loop;
  return {
    sourceTool:
      federated && typeof loop?.sourceTool === "string"
        ? (loop.sourceTool as string)
        : undefined,
    github: federated && loop?.github === true,
    alwaysAsk: loop?.alwaysAsk === true,
  };
}
export async function invokeTool(
  run: Run,
  binding: ToolBinding,
  callId: string,
  args: Record<string, unknown>,
): Promise<{ pending: string } | { result: any; artifactId: string }> {
  assertFleetEffect(run.owner_id, "run", run.id);
  if (run.payload.reviewId)
    throw new Problem(
      403,
      "Snapshot reviews can only read their captured repository",
    );
  if (!run.agent_id) throw new Problem(400, "Tool calls require an agent");
  const agentId = run.agent_id;
  // An unpinned merge is refused before approval and never sent. Returning a
  // tool error lets the agent re-read the PR and retry with the head SHA.
  const target = ownedMcpConnection(binding.connectionId, run.owner_id);
  const descriptor = JSON.parse(target.tools).find(
    (tool: any) => tool.name === binding.tool,
  );
  const hints = loop55Hints(target, descriptor);
  const displayTool = hints.sourceTool || binding.tool;
  const githubTool = isGithubMcpUrl(target.url) || hints.github;
  const unpinned = githubTool && mergeHeadProblem(displayTool, args);
  if (unpinned)
    return {
      result: { isError: true, content: [{ type: "text", text: unpinned }] },
      artifactId: "",
    };
  const { connection, hints: authorized } = authorizeTool(
    run.owner_id,
    run.agent_id,
    binding.connectionId,
    binding.tool,
    args,
  );
  let invocation = toolInvocationsQueries.byCall(db, run.id, callId) as
    QueryRow<"tool_invocations"> | undefined;
  if (
    invocation &&
    (invocation.connection_id !== connection.id ||
      invocation.tool !== binding.tool ||
      invocation.args !== JSON.stringify(args))
  )
    throw new Problem(409, "Tool call identity was reused for different input");
  if (invocation && ["completed", "failed"].includes(invocation.state)) {
    if (invocation.result === null || invocation.artifact_id === null)
      throw new Problem(
        409,
        `Tool invocation ${invocation.id} has no saved result`,
      );
    return {
      result: JSON.parse(invocation.result),
      artifactId: invocation.artifact_id,
    };
  }
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
      const automaticallyAllowed =
        mcpApprovalMode(run.owner_id) === "allow" && !authorized.alwaysAsk;
      let approval = invocation?.approval_id
        ? ownedApproval(invocation.approval_id, run.owner_id)
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
            message: `Allow @${run.payload.name || "agent"} to call ${displayTool} on ${connection.name}?`,
            callId,
          },
          automaticallyAllowed,
        );
        const invocationId = id();
        toolInvocationsQueries.insertPending(
          db,
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
        invocation = QueryRecords.tool_invocations.parse(
          toolInvocationsQueries.byId(db, invocationId),
        );
      }
      if (
        approval.state === "pending" &&
        automaticallyAllowed &&
        approval.expires_at > now()
      ) {
        const approved = approvalsQueries.approveUnexpired(
          db,
          approval.id,
          now(),
        );
        approval = ownedApproval(approval.id, run.owner_id);
        if (approved.changes) {
          emit(run.owner_id, run.id, "approval.auto_approved", {
            approvalId: approval.id,
          });
        }
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
        const row = toolInvocationsQueries.startPending(db, invocation!.id);
        if (!row.changes)
          throw new Problem(409, "Tool execution already started");
        approvalsQueries.startApproved(db, approval.id);
      }).immediate();
      return approval;
    })
    .immediate();
  if (approval.state === "pending") return { pending: approval.id };
  const invocationId = QueryRecords.tool_invocations.parse(invocation).id;
  recordTrace(run, "tool:" + callId, {
    kind: "tool",
    title: binding.tool,
    metadata: { state: "running" },
  });
  let client;
  let phase = "connecting";
  const watched = watchRun(run);
  const started = now();
  let received = false;
  try {
    watched.signal.throwIfAborted();
    client = await connectForRun(connection, run.id, callId);
    authorizeTool(
      run.owner_id,
      run.agent_id,
      binding.connectionId,
      binding.tool,
      args,
    );
    const live = ownedRun(run.id, run.owner_id);
    if (live.state !== "running")
      throw new Problem(409, "Run is no longer executing");
    assertFleetEffect(run.owner_id, "run", run.id);
    phase = "calling";
    let result: any = await client.callTool(
      { name: binding.tool, arguments: args },
      undefined,
      { timeout: MCP_TOOL_TIMEOUT_MS, signal: watched.signal },
    );
    received = true;
    phase = "saving the result";
    const redact = (value: unknown) =>
      redactCredentials(value, [
        readSecret(connection),
        // OAuth may rotate credentials during a tool call.
        readSecret(ownedMcpConnection(connection.id, run.owner_id)),
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
      tool: displayTool,
      fetchedAt: now(),
      fixture: metadata.fixture === true,
      github: githubTool,
    });
    const artifactId = db
      .transaction(() => {
        const artifactId = saveArtifact(run.owner_id, {
          ...normalized,
          agent: run.agent_id,
          conversation: run.conversation_id,
          run: run.id,
          folder: run.payload.folderId,
          metadata: {
            messageId: (
              agentCheckpointsQueries.message(db, run.id) as
                QueryRow<"agent_checkpoints"> | undefined
            )?.message_id,
            connectionId: connection.id,
            tool: binding.tool,
            arguments: args,
            invocationId: invocationId,
            fetchedAt: now(),
            toolResult: result,
            isError: toolFailed,
            fixture: metadata.fixture === true,
          },
        });
        toolInvocationsQueries.complete(
          db,
          toolFailed ? "failed" : "completed",
          JSON.stringify(result),
          artifactId,
          invocationId,
        );
        approvalsQueries.completeResult(
          db,
          JSON.stringify({ artifactId, isError: toolFailed }),
          approval.id,
        );
        return artifactId;
      })
      .immediate();
    if (
      binding.tool === "create_pull_request" &&
      isGithubMcpUrl(connection.url)
    ) {
      const pr = createdPullRequest(result, args);
      // The external create has already succeeded. Registration must never
      // turn its known result into an uncertain tool failure.
      if (pr) {
        try {
          (await import("../pr-watches.js")).watchCreatedPullRequest(run, pr);
        } catch {}
      }
    }
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
    if (watched.signal.aborted) error = watched.signal.reason;
    const elapsedMs = now() - started;
    const facts = {
      ...errorFacts(error),
      ...(error instanceof Problem ? error.diagnostic : {}),
    };
    let cause = errorSummary(error, [], false);
    try {
      const secrets = [
        readSecret(connection),
        readSecret(ownedMcpConnection(connection.id, run.owner_id)),
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
    const message = `${connection.name} · ${binding.tool} failed while ${phase} after ${Math.ceil(elapsedMs / 1000)}s: ${cause}${outcome === "unknown" ? " Its external outcome is unknown; it will not be replayed." : outcome === "received" ? " The tool responded, but Loop55 could not save the result. The call will not be replayed." : " The tool request was not sent."}`;
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
    toolInvocationsQueries.unknownExecuting(
      db,
      JSON.stringify({
        isError: true,
        content: [{ type: "text", text: message }],
        failure,
      }),
      invocationId,
    );
    approvalsQueries.unknownExecuting(
      db,
      JSON.stringify({ error: message, failure }),
      approval.id,
    );
    throw new Problem(
      error instanceof Problem ? error.status : 422,
      message,
      failure,
    );
  } finally {
    watched.release();
    if (JSON.parse(connection.metadata).transport !== "stdio")
      await client?.close().catch(() => {});
  }
}
