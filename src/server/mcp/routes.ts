import * as runsQueries from "../sql/runs.js";
import { workspaceApi } from "../../shared/workspace-api.js";
import { McpToolCallInput } from "../../shared/mcp-contract-schemas.js";
import { registrar, projectResponse } from "../registrar.js";
import type { QueryRow } from "../query-records.js";
import {
  McpConnectionRecord,
  parseRecord,
  runResponse,
} from "../row-schemas.js";

import { z } from "zod";
import { artifactRefreshSource } from "../../shared/artifact-refresh.js";
import { db, id, now } from "../db.js";
import {
  owned,
  ownedMcpConnection,
  ownedAgent,
  ownedFolder,
  ownedArtifact,
  ownedRun,
  Problem,
} from "../domain.js";
import { seal } from "../secrets.js";
import { enqueue, transition, type Run } from "../queue.js";
import {
  authorize,
  discover,
  readSecret,
  type MCPConnection,
} from "./client.js";
import { authorizeTool, invokeTool, toolBindings } from "./broker.js";
import { privateMcpUrl } from "./credentials.js";
import { ToolBudgetError } from "./tool-budget.js";
import { installConfig } from "./install.js";
import { config } from "../config.js";
import { companionMode } from "../profile.js";
import { publicCatalog, reviewedAt } from "./catalog-data.js";
import { installCatalog } from "./catalog.js";
import {
  agentPermissionMode,
  mcpApprovalMode,
  setAgentPermissionMode,
  setMcpApprovalMode,
} from "./approval-policy.js";
import { toolErrorMessage } from "./results.js";
import {
  importNativeMcpCandidate,
  publicNativeMcpCandidates,
} from "./native-config-import.js";
const routes = registrar("mcp");
export const mcp = routes.mount;
routes.on(workspaceApi.mcpPreferences, (_req, res) =>
  res.json({
    approvalMode: mcpApprovalMode(res.locals.owner),
    agentPermissionMode: agentPermissionMode(res.locals.owner),
  }),
);
routes.on(workspaceApi.mcpPreferencesUpdate, (req, res) => {
  const data = req.body;
  const agent = data.agentPermissionMode
    ? setAgentPermissionMode(res.locals.owner, data.agentPermissionMode)
    : { agentPermissionMode: agentPermissionMode(res.locals.owner) };
  const tools = data.approvalMode
    ? setMcpApprovalMode(res.locals.owner, data.approvalMode)
    : { approvalMode: mcpApprovalMode(res.locals.owner), resumed: 0 };
  res.json({ ...tools, ...agent });
});
routes.on(workspaceApi.mcpCatalog, (_req, res) => {
  res.json({
    entries: publicCatalog(),
    reviewedAt,
    oauthRedirectUrl: config.url + "/api/mcp/oauth/callback",
  });
});
// Installed-harness configs belong to whoever runs this Loop55 process. In a
// multi-user server they hold the operator's credentials, which are never
// any signed-in user's to list or import.
const nativeImportAllowed = () =>
  companionMode || config.authMode !== "multi-user";
routes.on(workspaceApi.mcpNativeCandidates, async (_req, res) => {
  res.json(nativeImportAllowed() ? await publicNativeMcpCandidates() : []);
});
routes.on(workspaceApi.mcpNativeImport, async (req, res) => {
  if (!nativeImportAllowed())
    throw new Problem(
      403,
      "Importing installed harness MCP servers is available only on a personal Loop55.",
    );
  res
    .status(201)
    .json(
      projectResponse(
        workspaceApi.mcpNativeImport,
        await importNativeMcpCandidate(res.locals.owner, String(req.params.id)),
      ),
    );
});
routes.on(workspaceApi.mcpCatalogInstall, async (req, res) => {
  const data = req.body;
  res.json(
    projectResponse(
      workspaceApi.mcpCatalogInstall,
      await installCatalog(
        res.locals.owner,
        String(req.params.id),
        data.values,
        data.runtimeHostId,
      ),
    ),
  );
});
routes.on(workspaceApi.mcpInstall, async (req, res) => {
  const d = req.body;
  res
    .status(201)
    .json(
      projectResponse(
        workspaceApi.mcpInstall,
        await installConfig(
          res.locals.owner,
          d.config,
          d.agentId,
          "",
          d.runtimeHostId,
        ),
      ),
    );
});
function publicConnection(c: MCPConnection) {
  const { secret, ...safe } = c;
  return projectResponse(workspaceApi.mcpCreate, {
    ...safe,
    authType: readSecret(c).type,
  });
}
routes.on(workspaceApi.mcpList, (_req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM mcp_connections WHERE owner_id=? ORDER BY created_at DESC",
      )
      .all(res.locals.owner)
      .map((c) => publicConnection(c as MCPConnection)),
  ),
);
routes.on(workspaceApi.mcpCreate, async (req, res) => {
  const data = req.body,
    stored = privateMcpUrl(data.url, data.auth),
    connection = id();
  db.prepare(
    "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,created_at) VALUES(?,?,?,?,?,'needs_auth',?)",
  ).run(
    connection,
    res.locals.owner,
    data.name,
    stored.url,
    seal(JSON.stringify(stored.auth), res.locals.owner),
    now(),
  );
  res
    .status(201)
    .json(publicConnection(ownedMcpConnection(connection, res.locals.owner)));
});
routes.on(workspaceApi.mcpTest, async (req, res) => {
  const c = ownedMcpConnection(String(req.params.id), res.locals.owner);
  try {
    if (readSecret(c).type === "oauth") {
      const a = await authorize(c);
      if (a.authorizationUrl) {
        res.json(projectResponse(workspaceApi.mcpTest, a));
        return;
      }
    }
    await discover(c);
    res.json(publicConnection(ownedMcpConnection(c.id, c.owner_id)));
  } catch (e) {
    db.prepare("UPDATE mcp_connections SET status=? WHERE id=?").run(
      e instanceof ToolBudgetError ? "disabled" : "needs_auth",
      c.id,
    );
    throw e;
  }
});
routes.on(workspaceApi.mcpUpdate, async (req, res) => {
  const raw = owned("mcp_connections", String(req.params.id), res.locals.owner);
  const data = req.body;
  // Disconnect never dispatches a tool or reuses the old credential.
  const c =
    data.action === "disconnect"
      ? parseRecord(McpConnectionRecord, raw, "mcp_connections")
      : ownedMcpConnection(String(req.params.id), res.locals.owner);
  if (data.action === "disconnect") {
    db.transaction(() => {
      db.prepare(
        "UPDATE mcp_connections SET status='disconnected',secret=? WHERE id=?",
      ).run(seal(JSON.stringify({ type: "none" }), c.owner_id), c.id);
      db.prepare("DELETE FROM grants WHERE connection_id=?").run(c.id);
      db.prepare("DELETE FROM oauth_states WHERE connection_id=?").run(c.id);
    }).immediate();
  } else if (data.action === "credentials") {
    if (!data.auth) throw new Problem(400, "Provide new credentials");
    db.prepare(
      "UPDATE mcp_connections SET secret=?,status='needs_auth' WHERE id=?",
    ).run(
      seal(
        JSON.stringify({ ...data.auth, query: readSecret(c).query }),
        c.owner_id,
      ),
      c.id,
    );
  } else if (data.action === "enable") {
    if (c.status !== "disabled")
      throw new Problem(409, "Reconnect this account first");
    await discover(c);
  } else
    db.prepare("UPDATE mcp_connections SET status='disabled' WHERE id=?").run(
      c.id,
    );
  res.json(publicConnection(ownedMcpConnection(c.id, c.owner_id)));
});
routes.on(workspaceApi.mcpOauthCallback, async (req, res) => {
  const state = String(req.query.state || ""),
    code = String(req.query.code || "");
  const saved = db
    .transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM oauth_states WHERE state=? AND owner_id=? AND expires_at>?",
        )
        .get(state, res.locals.owner, now()) as
        QueryRow<"oauth_states"> | undefined;
      if (!row)
        throw new Problem(
          403,
          "OAuth state expired or belongs to another session",
        );
      db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
      return row;
    })
    .immediate();
  if (!code || code.length > 4000)
    throw new Problem(400, "MCP sign-in was not completed");
  const c = ownedMcpConnection(saved.connection_id, res.locals.owner);
  await authorize(c, code);
  await discover(c);
  res.redirect("/?tools=connected");
});
routes.on(workspaceApi.agentTools, (req, res) => {
  res.json(
    toolBindings(res.locals.owner, String(req.params.id)).map((binding) => ({
      connection_id: binding.connectionId,
      tool: binding.tool,
    })),
  );
});
routes.on(workspaceApi.agentToolsUpdate, (req, res) => {
  ownedAgent(String(req.params.id), res.locals.owner);
  throw new Problem(
    410,
    "MCP tools are now available to all agents. Manage connections in Settings → Tools & integrations.",
  );
});
export function queueTool(
  owner: string,
  data: {
    agentId: string;
    connectionId: string;
    tool: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
    folderId?: string;
  },
) {
  const a = ownedAgent(data.agentId, owner);
  authorizeTool(owner, a.id, data.connectionId, data.tool, data.arguments);
  if (data.folderId) ownedFolder(data.folderId, owner);
  return enqueue(owner, "Call " + data.tool, data.idempotencyKey, {
    kind: "mcp",
    agent: a.id,
    payload: { name: a.name, ...data },
  });
}
routes.on(workspaceApi.artifactToolCall, (req, res) => {
  const a = ownedArtifact(String(req.params.id), res.locals.owner),
    meta = a.metadata;
  if (!a.agent_id || !meta.connectionId)
    throw new Problem(400, "This artifact has no tool context");
  const body = req.body;
  res.json(
    runResponse(
      queueTool(res.locals.owner, {
        ...body,
        agentId: a.agent_id,
        connectionId: meta.connectionId,
        folderId: a.folder_id || undefined,
      }),
    ),
  );
});
routes.on(workspaceApi.artifactRefresh, (req, res) => {
  const a = ownedArtifact(String(req.params.id), res.locals.owner),
    meta = a.metadata;
  const source = artifactRefreshSource(a.agent_id, meta);
  if (!source) throw new Problem(400, "No refresh source is available");
  res.json(
    runResponse(
      queueTool(res.locals.owner, {
        ...McpToolCallInput.parse({
          ...req.body,
          tool: source.tool,
          arguments: source.arguments,
        }),
        agentId: source.agentId,
        connectionId: source.connectionId,
        folderId: a.folder_id || undefined,
      }),
    ),
  );
});
export async function executeMcp(run: Run) {
  const p = z
      .object({
        tool: z.string().min(1),
        connectionId: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
      })
      .parse(run.payload),
    out = await invokeTool(
      run,
      {
        name: p.tool,
        tool: p.tool,
        connectionId: p.connectionId,
        description: "",
        inputSchema: {},
      },
      "manual-call",
      p.arguments,
    );
  if ("pending" in out) return false;
  runsQueries.setResult(
    db,
    JSON.stringify({ artifactId: out.artifactId }),
    run.id,
  );
  if (out.result.isError === true)
    throw new Problem(422, "Tool error: " + toolErrorMessage(out.result));
  const state = ownedRun(run.id, run.owner_id).state;
  if (state === "pausing") {
    transition(run, "paused");
    return false;
  }
  return true;
}

routes.on(workspaceApi.artifactApp, (req, res) => {
  const a = ownedArtifact(String(req.params.id), res.locals.owner),
    meta = a.metadata;
  if (typeof meta.appResource?.html !== "string")
    throw new Problem(404, "App resource not found");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  );
  res.type("html").send(meta.appResource.html);
});
