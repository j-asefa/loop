import { registrar } from "../registrar.js";
import type { QueryRow } from "../query-records.js";
import { McpConnectionRecord, parseRecord, runResponse } from "../row-schemas.js";


import { z } from "zod";
import {
  artifactRefreshSource,
  toolInvocationSchema,
} from "../../shared/artifact-refresh.js";
import { db, id, now } from "../db.js";
import { owned, ownedMcpConnection, ownedAgent, ownedFolder, ownedArtifact, ownedRun, Problem } from "../domain.js";
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
import {
  isPermissionMode,
  type PermissionMode,
} from "../../shared/permission-modes.js";
import { toolErrorMessage } from "./results.js";
import {
  importNativeMcpCandidate,
  publicNativeMcpCandidates,
} from "./native-config-import.js";
const routes = registrar("mcp");
export const mcp = routes.mount;
routes.legacy("GET /mcp/preferences", (_req, res) =>
  res.json({
    approvalMode: mcpApprovalMode(res.locals.owner),
    agentPermissionMode: agentPermissionMode(res.locals.owner),
  }),
);
routes.legacy("PUT /mcp/preferences", (req, res) => {
  const data = z
    .object({
      approvalMode: z.enum(["ask", "allow"]).optional(),
      agentPermissionMode: z
        .custom<PermissionMode>(isPermissionMode, "Unknown permission mode")
        .optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.approvalMode !== undefined ||
        value.agentPermissionMode !== undefined,
      "Choose a preference to change",
    )
    .parse(req.body);
  const agent = data.agentPermissionMode
    ? setAgentPermissionMode(res.locals.owner, data.agentPermissionMode)
    : { agentPermissionMode: agentPermissionMode(res.locals.owner) };
  const tools = data.approvalMode
    ? setMcpApprovalMode(res.locals.owner, data.approvalMode)
    : { approvalMode: mcpApprovalMode(res.locals.owner), resumed: 0 };
  res.json({ ...tools, ...agent });
});
routes.legacy("GET /mcp/catalog", (_req, res) => {
  res.json({
    entries: publicCatalog(),
    reviewedAt,
    oauthRedirectUrl: config.url + "/api/mcp/oauth/callback",
  });
});
// Installed-harness configs belong to whoever runs this Loop process. In a
// multi-user server they hold the operator's credentials, which are never
// any signed-in user's to list or import.
const nativeImportAllowed = () =>
  companionMode || config.authMode !== "multi-user";
routes.legacy("GET /mcp/native-candidates", async (_req, res) => {
  res.json(nativeImportAllowed() ? await publicNativeMcpCandidates() : []);
});
routes.legacy("POST /mcp/native-candidates/:id/import", async (req, res) => {
  if (!nativeImportAllowed())
    throw new Problem(
      403,
      "Importing installed harness MCP servers is available only on a personal Loop.",
    );
  res
    .status(201)
    .json(
      await importNativeMcpCandidate(res.locals.owner, String(req.params.id)),
    );
});
routes.legacy("POST /mcp/catalog/:id/install", async (req, res) => {
  const data = z
    .object({
      values: z.record(z.string().max(100), z.string().max(10000)).default({}),
      runtimeHostId: z.string().max(200).optional(),
    })
    .strict()
    .parse(req.body);
  res.json(
    await installCatalog(
      res.locals.owner,
      String(req.params.id),
      data.values,
      data.runtimeHostId,
    ),
  );
});
routes.legacy("POST /mcp/install", async (req, res) => {
  const d = z
    .object({
      config: z.union([
        z.string().max(50000),
        z.record(z.string(), z.unknown()),
      ]),
      agentId: z.string().optional(),
      runtimeHostId: z.string().optional(),
    })
    .parse(req.body);
  res
    .status(201)
    .json(
      await installConfig(
        res.locals.owner,
        d.config,
        d.agentId,
        "",
        d.runtimeHostId,
      ),
    );
});
const secretSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("oauth") }),
  z.object({ type: z.literal("bearer"), token: z.string().min(1).max(10000) }),
  z.object({
    type: z.literal("headers"),
    headers: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        z.string().min(1).max(10000),
      )
      .refine(
        (h) =>
          Object.keys(h).length <= 8 &&
          !Object.keys(h).some((k) =>
            /^(host|cookie|origin|referer|connection|content-length|transfer-encoding|proxy-.*|sec-.*)$/i.test(
              k,
            ),
          ),
        "Unsupported authentication header",
      ),
  }),
]);
function publicConnection(c: MCPConnection) {
  const { secret, ...safe } = c;
  return { ...safe, authType: readSecret(c).type };
}
routes.legacy("GET /mcp", (_req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM mcp_connections WHERE owner_id=? ORDER BY created_at DESC",
      )
      .all(res.locals.owner)
      .map((c) => publicConnection(c as MCPConnection)),
  ),
);
routes.legacy("POST /mcp", async (req, res) => {
  const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        url: z.string().max(2000),
        auth: secretSchema,
      })
      .parse(req.body),
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
    .json(
      publicConnection(ownedMcpConnection(connection, res.locals.owner)),
    );
});
routes.legacy("POST /mcp/:id/test", async (req, res) => {
  const c = ownedMcpConnection(String(req.params.id), res.locals.owner);
  try {
    if (readSecret(c).type === "oauth") {
      const a = await authorize(c);
      if (a.authorizationUrl) {
        res.json(a);
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
routes.legacy("PATCH /mcp/:id", async (req, res) => {
  const raw = owned("mcp_connections", String(req.params.id), res.locals.owner);
  const data = z
      .object({
        action: z.enum(["disable", "enable", "disconnect", "credentials"]),
        auth: secretSchema.optional(),
      })
      .parse(req.body);
  // Disconnect never dispatches a tool or reuses the old credential.
  const c = data.action === "disconnect"
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
routes.legacy("GET /mcp/oauth/callback", async (req, res) => {
  const state = String(req.query.state || ""),
    code = String(req.query.code || "");
  const saved = db
    .transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM oauth_states WHERE state=? AND owner_id=? AND expires_at>?",
        )
        .get(state, res.locals.owner, now()) as QueryRow<"oauth_states"> | undefined;
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
routes.legacy("GET /agents/:id/tools", (req, res) => {
  res.json(
    toolBindings(res.locals.owner, String(req.params.id)).map((binding) => ({
      connection_id: binding.connectionId,
      tool: binding.tool,
    })),
  );
});
routes.legacy("PUT /agents/:id/tools", (req, res) => {
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
const callSchema = toolInvocationSchema.extend({
  idempotencyKey: z.string().min(10).max(200),
});
routes.legacy("POST /artifacts/:id/tool-call", (req, res) => {
  const a = ownedArtifact(String(req.params.id), res.locals.owner),
    meta = a.metadata;
  if (!a.agent_id || !meta.connectionId)
    throw new Problem(400, "This artifact has no tool context");
  const body = callSchema.parse(req.body);
  res.json(
    runResponse(queueTool(res.locals.owner, {
      ...body,
      agentId: a.agent_id,
      connectionId: meta.connectionId,
      folderId: a.folder_id || undefined,
    })),
  );
});
routes.legacy("POST /artifacts/:id/refresh", (req, res) => {
  const a = ownedArtifact(String(req.params.id), res.locals.owner),
    meta = a.metadata;
  const source = artifactRefreshSource(a.agent_id, meta);
  if (!source) throw new Problem(400, "No refresh source is available");
  res.json(
    runResponse(queueTool(res.locals.owner, {
      ...callSchema.parse({
        ...req.body,
        tool: source.tool,
        arguments: source.arguments,
      }),
      agentId: source.agentId,
      connectionId: source.connectionId,
      folderId: a.folder_id || undefined,
    })),
  );
});
export async function executeMcp(run: Run) {
  const p = z.object({ tool: z.string().min(1), connectionId: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).parse(run.payload),
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
  db.prepare("UPDATE runs SET result=? WHERE id=?").run(
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

routes.legacy("GET /artifacts/:id/app", (req, res) => {
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
