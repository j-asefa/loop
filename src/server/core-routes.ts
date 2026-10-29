import { passiveWorkspaceRead } from "./workspace-read-context.js";
import { submitTokenWrite, runControlTokenWrite } from "./token-write-policies.js";
import { recordCardRead, tokenResultPage } from "./card-tokens.js";
import { registrar, projectResponse } from "./registrar.js";
import { workspaceApi, PublicAgent, PublicConnection, PublicFolder, PublicMessage, ResultItem } from "../shared/workspace-api.js";

import { InvalidRow, parseConnectionControl, ConnectionModels, ConnectionMetadata, runResponse, messageResponse } from "./row-schemas.js";
import type { QueryRow } from "./query-records.js";


import { projectionSnapshot } from "./projection-snapshot.js";
import { writeConnectionStatus } from "./connection-status.js";
import { localArtifact } from "./published-files.js";
import { sendHtmlPreview } from "./file-preview.js";
import {
  isNativeConnection,
  NATIVE_CONNECTION_SQL,
} from "./native-connections.js";
import { executionRequest } from "./execution-client.js";
import { nativeSessions } from "./native-sessions.js";
import { hostEnvironmentName } from "./execution-location.js";
import {
  resultsRevision,
  resultsUpdates,
  resultOutputSql,
  fileArtifactSql,
  projectFolders,
} from "./results.js";
import { agentTraces, runTraceExport } from "./traces.js";
import { personalHistory } from "./personal-history.js";
import { personalFiles } from "./personal-files.js";
import { personalDecisions, personalApproval } from "./personal-decisions.js";
import { readProfile, saveProfile } from "./user-profile.js";
import { agentMessages } from "./agent-messages.js";
import { conversationMessages, latestAgentMessage } from "./conversation-messages.js";
import { conversationPulls } from "./conversation-pulls.js";
import { cancelRun, dismissRun } from "./run-attention.js";
import { conversationReturnState } from "./mobile-return.js";
import {
  isSubscription,
  runtimeAction,
  runtimeConfigured,
  runtimeWorkspaceKey,
} from "./subscriptions.js";

import { z } from "zod";
import { db, emit, id, now } from "./db.js";
import { owned, ownedAgent, ownedConversation, ownedArtifact, ownedConnection, ownedMessage, ownedRun, renameAgent, Problem, agentInput, validateEffort } from "./domain.js";
import { createWithPrompt } from "./agent-creation.js";
import { suggestAgentName } from "./agent-names.js";
import { adapter } from "./providers.js";
import { seal, unseal } from "./secrets.js";
import { nextTurnConnection, submit } from "./agent-runtime.js";
import { activeRun } from "./steering.js";
import { transition } from "./queue.js";

import { assertTeamRestoreCapacity, listTeams, teamFilter } from "./teams.js";
import { assertTeamConnectionChange } from "./team-eligibility.js";
import { viewportDiagnostics } from "./viewport-diagnostics.js";
import { ensureWorkspaceProject } from "./workspace-project.js";
import { publicPreview } from "../preview-context.js";
const routes = registrar("core", { middleware: [[viewportDiagnostics]] });
export const core = routes.mount;

routes.on(workspaceApi.bootstrap, (_req, res) => {
  if (!res.locals.bearer && !passiveWorkspaceRead(res.locals.owner)) ensureWorkspaceProject(res.locals.owner);
  res.json({
    ...(publicPreview ? { preview: publicPreview } : {}),
    environmentName: hostEnvironmentName(),
    teams: listTeams(res.locals.owner),
    agents: db
      .prepare("SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC")
      .all(res.locals.owner) as z.input<typeof PublicAgent>[],
    connections: db
      .prepare(
        "SELECT id,provider,label,status,models,metadata FROM connections WHERE owner_id=?",
      )
      .all(res.locals.owner) as z.input<typeof PublicConnection>[],
    folders: db
      .prepare(
        "SELECT f.*,p.path,EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=f.owner_id AND w.project_id=f.id) is_workspace FROM folders f LEFT JOIN project_paths p ON p.folder_id=f.id WHERE f.owner_id=? ORDER BY f.name",
      )
      .all(res.locals.owner) as z.input<typeof PublicFolder>[],
    identityProviders: process.env.GITHUB_CLIENT_ID ? ["github"] : [],
    capabilities: {
      codex: runtimeConfigured(),
      claudeLogin: runtimeConfigured(),
    },
  });
});
routes.on(workspaceApi.connectionCreate, async (req, res) => {
  const d = req.body;
  let models;
  try {
    models = await adapter(d.provider).models(d.secret);
  } catch {
    throw new Problem(
      422,
      "Could not validate the connection. Check the API key, account access and network, then try again.",
    );
  }
  const record = id();
  writeConnectionStatus(record, () => db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    record,
    res.locals.owner,
    d.provider,
    d.label,
    seal(d.secret, res.locals.owner),
    "connected",
    JSON.stringify(ConnectionModels.parse(models)),
    JSON.stringify(ConnectionMetadata.parse({
      billing: "API-billed",
      scope:
        "Models available to this key; consumer chat history is not included",
    })),
    now(),
  ));
  res.json({ id: record, models });
});
routes.on(workspaceApi.connectionRefresh, async (req, res) => {
  const c = ownedConnection(req.params.id, res.locals.owner);
  if (isNativeConnection(c)) {
    const harness = c.metadata.loopHarness;
    return res.json(
      await executionRequest("runtime.refresh", { connectionId: c.id }, { owner: res.locals.owner }),
    );
  }
  if (isSubscription(c))
    throw new Problem(
      400,
      "Refresh this subscription through its sign-in status.",
    );
  try {
    const models = await adapter(c.provider).models(
      unseal(c.secret, res.locals.owner),
    );
    writeConnectionStatus(c.id, () => db.prepare(
      "UPDATE connections SET models=?,status='connected' WHERE id=?",
    ).run(JSON.stringify(ConnectionModels.parse(models)), c.id));
    res.json({ models });
  } catch {
    writeConnectionStatus(c.id, () => db.prepare(
      "UPDATE connections SET status='needs_reconnect' WHERE id=?",
    ).run(c.id));
    throw new Problem(
      422,
      "Connection could not be refreshed. Reconnect with a valid API key.",
    );
  }
});
routes.on(workspaceApi.connectionModels, async (req, res) => {
  const c = ownedConnection(req.params.id, res.locals.owner);
  if (c.status !== "connected")
    throw new Problem(409, "Reconnect this provider first");
  if (passiveWorkspaceRead(res.locals.owner)) {
    res.json({ models: c.models });
    return;
  }
  if (isNativeConnection(c)) {
    // The refresh stores the harness's complete validated catalog; native
    // providers such as Pi with OpenRouter report more models and longer ids
    // than the API-key bounds below allow.
    await executionRequest("runtime.refresh", { connectionId: c.id }, { owner: res.locals.owner });
    res.json({ models: ownedConnection(c.id, res.locals.owner).models });
    return;
  }
  let models;
  if (isSubscription(c)) {
    const result = await runtimeAction(c, "status");
    if (!result.authenticated)
      throw new Problem(409, "Reconnect this provider first");
    models = result.models;
  } else
    models = await adapter(c.provider).models(
      unseal(c.secret, res.locals.owner),
    );
  const catalog = z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().max(200),
        resolvedModel: z.string().min(1).max(200).optional(),
        capabilities: z.string().max(500).optional(),
        effortLevels: z
          .array(
            z.object({
              value: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
              description: z.string().max(1000).optional(),
            }),
          )
          .max(20)
          .optional(),
        defaultEffort: z.string().max(32).optional(),
      }),
    )
    .max(300)
    .parse(models);
  db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    JSON.stringify(ConnectionModels.parse(catalog)),
    c.id,
  );
  res.json({ models: catalog });
});
routes.on(workspaceApi.connectionReconnect, async (req, res) => {
  const c = ownedConnection(req.params.id, res.locals.owner),
    secret = req.body.secret;
  if (isSubscription(c))
    throw new Problem(
      400,
      "Use subscription sign-in to reconnect this account.",
    );
  try {
    const models = await adapter(c.provider).models(secret);
    writeConnectionStatus(c.id, () => db.prepare(
      "UPDATE connections SET secret=?,models=?,status='connected' WHERE id=?",
    ).run(seal(secret, res.locals.owner), JSON.stringify(ConnectionModels.parse(models)), c.id));
    res.json({ ok: true });
  } catch {
    throw new Problem(422, "Could not validate this API key");
  }
});
routes.on(workspaceApi.connectionDisconnect, async (req, res) => {
  const raw = owned("connections", req.params.id, res.locals.owner);
  let c: ReturnType<typeof parseConnectionControl> | undefined;
  try { c = parseConnectionControl(raw); }
  catch (error) { if (!(error instanceof InvalidRow)) throw error; }
  // Revocation must work for an unavailable row, without using its invalid
  // routing for an external logout or repairing it into an executable default.
  writeConnectionStatus(req.params.id, () => db.prepare(
    "UPDATE connections SET secret='',status='disconnected',metadata=CASE WHEN json_valid(metadata) THEN json_remove(metadata,'$.retiredDirectRuntime','$.nativeRecoveryRequired') ELSE metadata END WHERE id=? AND owner_id=?",
  ).run(req.params.id, res.locals.owner));
  if (c && isSubscription(c)) await runtimeAction(c, "logout");
  res.json({ ok: true });
});
routes.on(workspaceApi.agentSuggestName, (_req, res) =>
  res.set("Cache-Control", "no-store").json({ name: suggestAgentName() }),
);
routes.on(workspaceApi.agentCreate, (req, res) =>
  res.json(createWithPrompt(res.locals.owner, req.body)),
);
routes.on(workspaceApi.agentUpdate, (req, res) => {
  const result = db
    .transaction(() => {
      const owner = res.locals.owner,
        agent = ownedAgent(req.params.id, owner);
      if (req.body.retired !== undefined) {
        const retired = z.boolean().parse(req.body.retired);
        if (!retired && agent.retired_at != null)
          assertTeamRestoreCapacity(owner, agent.id);
        db.prepare(
          "UPDATE agents SET retired_at=? WHERE id=? AND owner_id=?",
        ).run(retired ? agent.retired_at || now() : null, agent.id, owner);
      }
      if (req.body.folderId !== undefined) {
        const folderId = z.string().min(1).nullable().parse(req.body.folderId);
        if (folderId) owned("folders", folderId, owner);
        db.prepare(
          "UPDATE agents SET folder_id=? WHERE id=? AND owner_id=?",
        ).run(folderId, agent.id, owner);
      }
      if (req.body.name !== undefined)
        renameAgent(owner, agent.id, req.body.name);
      if (req.body.instructions !== undefined)
        db.prepare("UPDATE agents SET instructions=? WHERE id=?").run(
          z.string().max(12000).parse(req.body.instructions),
          agent.id,
        );
      if (
        req.body.model !== undefined ||
        req.body.connectionId !== undefined ||
        req.body.effort !== undefined
      ) {
        const c = ownedConnection(z.string().parse(req.body.connectionId ?? agent.connection_id ?? ""), owner);
        if (c.status !== "connected")
          throw new Problem(409, "Reconnect this provider first");
        assertTeamConnectionChange(owner, agent.id, c);
        const model = z
          .string()
          .min(1)
          .max(200)
          .parse(req.body.model ?? agent.model);
        const effort = agentInput.shape.effort.parse(
          req.body.effort === undefined
            ? model === agent.model && c.id === agent.connection_id
              ? agent.effort
              : null
            : req.body.effort,
        );
        if (!c.models.some((m: { id: string }) => m.id === model))
          throw new Problem(400, "Model unavailable on this connection");
        validateEffort(c, model, effort);
        db.prepare(
          "UPDATE agents SET connection_id=?,provider=?,model=?,effort=? WHERE id=?",
        ).run(c.id, c.provider, model, effort || null, agent.id);
        if (c.id !== agent.connection_id)
          db.prepare(
            "UPDATE teams SET conversation_id=NULL WHERE owner_id=? AND manager_id=? AND deleted_at IS NULL",
          ).run(owner, agent.id);
      }
      return ownedAgent(agent.id, owner);
    })
    .immediate();
  res.json(result);
});
routes.on(workspaceApi.agentHarness, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const conversationId = req.query.conversation;
  const selected = conversationId
    ? ownedConversation(conversationId, res.locals.owner)
    : undefined;
  // The picker can pair the open conversation with another agent's composer.
  // That conversation says nothing about this agent's next turn, so list the
  // agent's new-task catalog rather than refusing.
  const conversation = selected?.agent_id === agent.id ? selected : undefined;
  const conversationKey: string | undefined = conversation?.id;
  const { connection } = nextTurnConnection(res.locals.owner, agent);
  if (!isSubscription(connection) && !isNativeConnection(connection)) {
    res.json({
      available: false,
      commands: [],
      message:
        "Commands and skills come from a Codex or Claude Code runtime. This agent uses an API connection.",
    });
    return;
  }
  const catalog = isNativeConnection(connection)
    ? await executionRequest("native.catalog", { agentId: agent.id, conversationId: conversationKey }, { owner: res.locals.owner })
    : await runtimeAction(connection, "capabilities", {
        workspaceKey: runtimeWorkspaceKey(res.locals.owner, agent.id),
      });
  if (!Array.isArray(catalog.commands))
    throw new Problem(
      422,
      "This runtime does not support command discovery. Update the runtime on that machine and try again.",
    );
  res.json(catalog);
});
// Mutations belong to the authority; configuration readback uses shared files/DB.
routes.on(workspaceApi.agentPiPackages, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  res.json(nativeSessions.piConfiguration(agent));
});
routes.on(workspaceApi.agentPiTrust, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const { trusted, fingerprint } = req.body;
  await executionRequest("pi.trust", { agentId: agent.id, trusted, fingerprint }, { owner: res.locals.owner });
  res.json(nativeSessions.piConfiguration(agent));
});
routes.on(workspaceApi.agentPiFilters, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const { source, scope, filters, settingsHash } = req.body;
  const result = await executionRequest("pi.filters", { agentId: agent.id, source, scope, filters, settingsHash }, { owner: res.locals.owner });
  res.json({ ...result, ...nativeSessions.piConfiguration(agent) });
});
routes.on(workspaceApi.agentPiPreview, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const input = req.body;
  res.json(
    await executionRequest("pi.preview", { agentId: agent.id, name: input.name, args: input.args, conversationId: input.conversation }, { owner: res.locals.owner }),
  );
});
routes.on(workspaceApi.agentPiInspect, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const { source } = req.body;
  res.json(await executionRequest("pi.inspect", { agentId: agent.id, source }, { owner: res.locals.owner }));
});
routes.on(workspaceApi.agentPiRollback, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const { source, scope } = req.body;
  const result = await executionRequest("pi.rollback", { agentId: agent.id, source, scope }, { owner: res.locals.owner });
  res.json({ ...result, ...nativeSessions.piConfiguration(agent) });
});
routes.on(workspaceApi.agentPiAction, async (req, res) => {
  const agent = ownedAgent(req.params.id, res.locals.owner);
  const input = req.body;
  const result = await executionRequest("pi.action", { agentId: agent.id, ...input }, { owner: res.locals.owner });
  res.json({ ...result, ...nativeSessions.piConfiguration(agent) });
});
routes.on(workspaceApi.agentTraces, (req, res) => {
  const { before, run: runId, q } = req.query;
  res.json(agentTraces(res.locals.owner, req.params.id, before, runId, q));
});
routes.on(workspaceApi.agentTracesExport, (req, res) => {
  const runId = req.query.run;
  const data = runTraceExport(res.locals.owner, req.params.id, runId);
  res.attachment(`loop-run-${runId}-traces.json`).json(data);
});
routes.on(workspaceApi.personalFiles, (req, res) => {
  res.json(personalFiles(res.locals.owner, req.query));
});
routes.on(workspaceApi.personalDecisions, (req, res) => {
  res.json(personalDecisions(res.locals.owner, req.query));
});
routes.on(workspaceApi.personalApproval, (req, res) => {
  res.json(personalApproval(res.locals.owner, req.params.id));
});
routes.on(workspaceApi.personalProfile, (_req, res) => {
  res.json(readProfile(res.locals.owner));
});
routes.on(workspaceApi.personalProfileUpdate, (req, res) => {
  res.json(saveProfile(res.locals.owner, req.body));
});
routes.on(workspaceApi.personalPrompts, (req, res) => {
  const { before, q } = req.query;
  res.json(personalHistory(res.locals.owner, before, q || undefined));
});
routes.on(workspaceApi.agentMessages, (req, res) => {
  const before = req.query.before;
  res.json(agentMessages(res.locals.owner, req.params.id, before));
});
routes.on(workspaceApi.agentDetail, (req, res) => {
  const a = ownedAgent(req.params.id, res.locals.owner);
  res.json({
    agent: a,
    runs: db
      .prepare(
        "SELECT * FROM runs WHERE owner_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner, a.id) as z.input<typeof workspaceApi.agentDetail.response>["runs"],
    conversations: db
      .prepare(
        "SELECT * FROM conversations WHERE owner_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner, a.id) as z.input<typeof workspaceApi.agentDetail.response>["conversations"],
  });
});
routes.on(workspaceApi.submit, (req, res) => {
  const { queue, ...data } = req.body;
  res.json(runResponse(submit(res.locals.owner, { ...data, steer: !queue, personal: true })));
}, { tokenWrite: submitTokenWrite });
routes.on(workspaceApi.runAction, (req, res) => {
  const action = req.params.action;
  if (action === "dismiss" || action === "cancel") {
    res.json((action === "dismiss" ? dismissRun : cancelRun)(res.locals.owner, req.params.id));
    return;
  }
  const run = ownedRun(req.params.id, res.locals.owner);
  if (
    action === "pause" &&
    ["running", "awaiting_approval"].includes(run.state) &&
    (db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id) ||
      db
        .prepare(
          `SELECT 1 FROM connections c WHERE c.id=? AND c.owner_id=? AND ${NATIVE_CONNECTION_SQL}`,
        )
        .get(run.payload.connectionId ?? null, run.owner_id))
  )
    throw new Problem(
      409,
      "This harness cannot suspend an active native turn. Interrupt this run, then send a follow-up; other agents keep running.",
    );
  if (action === "resume" && run.state !== "paused")
    throw new Problem(
      409,
      "Only a paused run can be resumed. Use a new retry for interrupted work.",
    );
  if (action === "retry") {
    if (
      !["failed", "interrupted"].includes(run.state) ||
      run.kind !== "agent" ||
      !run.agent_id
    )
      throw new Problem(409, "This run cannot be retried automatically");
    const d = z
      .object({ idempotencyKey: z.string().min(8).max(150) })
      .parse(req.body);
    res.json(
      runResponse(submit(res.locals.owner, {
        agentId: run.agent_id,
        conversationId: run.conversation_id || undefined,
        input: run.input,
        idempotencyKey: d.idempotencyKey,
        attachmentIds: run.payload.attachmentIds || [],
        replyTo: run.payload.replyTo,
      })),
    );
    return;
  }
  if (action === "resume" && run.state === "paused" && run.result) {
    if (!transition(run, "completed"))
      throw new Problem(409, "Run has already changed");
    res.json({ ok: true });
    return;
  }
  const next =
    action === "pause"
      ? run.state === "queued"
        ? "paused"
        : "pausing"
      : action === "resume"
        ? "queued"
        : null;
  if (!next || !transition(run, next))
    throw new Problem(409, "That action is not available in the current state");
  if (
    action === "pause" &&
    run.worker_id === null &&
    run.state === "running"
  )
    transition(run, "paused");
  res.json({ ok: true });
}, {
  tokenWrite: runControlTokenWrite,
  middleware: [(req, res, next) => {
    if (res.locals.bearer && !["cancel", "dismiss"].includes(req.params.action))
      throw new Problem(403, "This token permits only cancel and dismiss run actions.");
    next();
  }],
});
routes.on(workspaceApi.resultUpdates, (req, res) => {
  const options = { ...req.query, saved: req.query.saved === "1" };
  if (options.agent) owned("agents", options.agent, res.locals.owner);
  if (options.folder) owned("folders", options.folder, res.locals.owner);
  const teams = teamFilter(req.query.teams, res.locals.owner);
  res.json(tokenResultPage(res.locals.owner, res.locals.bearer?.tokenId,
    projectResponse(workspaceApi.resultUpdates, resultsUpdates(res.locals.owner, { ...options, teams })),
    !options.saved && options.view === "prompts" ? "m:" : "a:", res.req.method !== "HEAD"));
}, { wrap: handler => projectionSnapshot(handler, { bearerWrites: true }) });
routes.on(workspaceApi.results, (req, res) => {
  const saved = req.query.saved === "1";
  const revision = resultsRevision(res.locals.owner);
  const teams = teamFilter(req.query.teams, res.locals.owner);
  const cursor = req.query.before,
    limit = 40;
  const params: unknown[] = [res.locals.owner];
  let where =
    "a.owner_id=? AND a.archived=0" +
    (saved ? " AND a.pinned=1" : " AND a.feed_hidden=0");
  if (teams.length) {
    where +=
      " AND a.conversation_id IN (SELECT id FROM conversations WHERE owner_id=? AND team_id IN (" +
      teams.map(() => "?").join(",") +
      "))";
    params.push(res.locals.owner, ...teams);
  }
  if (req.query.folder) {
    owned("folders", String(req.query.folder), res.locals.owner);
    where += " AND EXISTS(SELECT 1 FROM json_each(?) WHERE value IS a.folder_id)";
    params.push(
      JSON.stringify(
        projectFolders(res.locals.owner, String(req.query.folder)),
      ),
    );
  }
  if (req.query.agent) {
    owned("agents", String(req.query.agent), res.locals.owner);
    where += " AND a.agent_id=?";
    params.push(req.query.agent);
  }
  if (cursor) {
    where += " AND p.sequence<?";
    params.push(cursor);
  }
  if (!saved && req.query.view === "prompts") {
    const values: unknown[] = [res.locals.owner];
    let filter = "m.owner_id=? AND m.role='user'";
    if (teams.length) {
      filter += " AND c.team_id IN (" + teams.map(() => "?").join(",") + ")";
      values.push(...teams);
    }
    if (req.query.folder) {
      filter +=
        " AND EXISTS (SELECT 1 FROM runs fr WHERE fr.id=m.run_id AND EXISTS(SELECT 1 FROM json_each(?) WHERE value IS json_extract(fr.payload,'$.folderId')))";
      values.push(
        JSON.stringify(
          projectFolders(res.locals.owner, String(req.query.folder)),
        ),
      );
    }
    if (req.query.agent) {
      filter += " AND c.agent_id=?";
      values.push(req.query.agent);
    }
    if (cursor) {
      filter += " AND m.rowid<?";
      values.push(cursor);
    }
    const rows = db
      .prepare(
        `SELECT m.*,r.state run_state,r.error run_error,m.rowid cursor,c.agent_id,c.team_id,a.name,a.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents a ON a.id=c.agent_id WHERE ${filter} ORDER BY m.rowid DESC LIMIT 40`,
      )
      .all(...values) as z.input<typeof ResultItem>[];
    res.json(tokenResultPage(res.locals.owner, res.locals.bearer?.tokenId,
      projectResponse(workspaceApi.results, {
        revision, items: rows, next: rows.length === 40 ? rows.at(-1)!.cursor : null,
      }), "a:", res.req.method !== "HEAD"));
    return;
  }
  if (saved) where += ` AND ${fileArtifactSql}`;
  else if (req.query.view === "files")
    where += ` AND ${fileArtifactSql} AND a.kind IN ('file','image','code','table','diagram','chart','workflow')`;
  else where += ` AND ${resultOutputSql}`;
  const items = db
    .prepare(
      `SELECT a.*,r.state run_state,r.error run_error,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,p.sequence AS cursor,g.name,g.provider,(SELECT team_id FROM conversations WHERE id=a.conversation_id) team_id FROM artifacts a JOIN ${saved ? "artifact_bookmarks" : "artifact_publications"} p ON p.artifact_id=a.id LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id LEFT JOIN agents g ON g.id=a.agent_id WHERE ${where} ORDER BY p.sequence DESC LIMIT ?`,
    )
    .all(...params, limit) as z.input<typeof ResultItem>[];
  res.json(tokenResultPage(res.locals.owner, res.locals.bearer?.tokenId,
    projectResponse(workspaceApi.results, {
      revision, items, next: items.length === limit ? items.at(-1)!.cursor : null,
    }), "a:", res.req.method !== "HEAD"));
}, { wrap: handler => projectionSnapshot(handler, { bearerWrites: true }) });
routes.on(workspaceApi.resultUpdate, (req, res) => {
  const item = ownedArtifact(req.params.id, res.locals.owner);
  const { hidden } = req.body;
  db.prepare(
    "UPDATE artifacts SET feed_hidden=? WHERE id=? AND owner_id=?",
  ).run(Number(hidden), item.id, res.locals.owner);
  if (item.run_id)
    emit(res.locals.owner, item.run_id, "feed.changed", {
      artifactId: item.id,
      hidden,
    });
  res.json({ ok: true });
});
routes.on(workspaceApi.conversation, (req, res) => {
  const c = ownedConversation(req.params.id, res.locals.owner);
  const before = req.query.before;
  const anchor = req.query.message;
  const resume = req.query.resume;
  const returned = conversationReturnState(res.locals.owner, req.params.id);
  let page = conversationMessages(res.locals.owner, req.params.id, before, anchor);
  let resumed = false;
  if (resume === "1" && !before && !anchor && returned.position_message_id &&
      !page.messages.some(message => message.id === returned.position_message_id)) {
    // Only an initial open opts into the saved position. Subsequent refreshes
    // still read the latest page; explicit anchors/cursors retain precedence.
    try {
      page = conversationMessages(res.locals.owner, req.params.id, undefined, returned.position_message_id);
      resumed = true;
    } catch (error) {
      // Saved positions can outlive deleted messages. Explicit anchors still
      // report 404, but a stale automatic resume keeps the latest page.
      if (!(error instanceof Problem) || error.status !== 404) throw error;
    }
  }
  let active: ReturnType<typeof activeRun>;
  try {
    active = activeRun(res.locals.owner, req.params.id, c.agent_id ?? undefined);
  } catch (error) {
    // The saved conversation stays readable so its unavailable run can be
    // interrupted. Submitting/steering still requires the full parsed row.
    if (!(error instanceof InvalidRow)) throw error;
  }
  res.json({
    conversation: c,
    // The run a reply would steer now; null means a reply queues.
    steerable_run_id: active?.liveInput ? active.run.id : null,
    ...page,
    ...returned,
    resumed,
    latest_agent_message: latestAgentMessage(res.locals.owner, req.params.id),
  });
}, { wrap: projectionSnapshot });
routes.on(workspaceApi.conversationPulls, async (req, res) => {
  res.json(await conversationPulls(res.locals.owner, req.params.id, req.query.refresh === "1"));
});
routes.on(workspaceApi.messageDetail, (req, res) =>
  res.json(messageResponse(ownedMessage(req.params.id, res.locals.owner))),
);
routes.on(workspaceApi.messageSearch, (req, res) => {
  const { q } = req.query;
  res.json(
    db
      .prepare(
        "SELECT * FROM messages WHERE owner_id=? AND instr(lower(content),lower(?))>0 ORDER BY created_at DESC LIMIT 50",
      )
      .all(res.locals.owner, q) as z.input<typeof PublicMessage>[],
  );
});

routes.on(workspaceApi.artifactFile, (req, res) => {
  const file = localArtifact(res.locals.owner, req.params.id);
  const artifact = ownedArtifact(req.params.id, res.locals.owner);
  if (res.locals.bearer && res.req.method !== "HEAD") recordCardRead(res.locals.owner, res.locals.bearer.tokenId, ["a:" + artifact.id]);
  const name = artifact.metadata.name || artifact.title;
  if (sendHtmlPreview(res, req.query.preview, { ...file, name })) return;
  const inline =
    req.query.preview === "1" &&
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mime);
  res.setHeader("Content-Type", file.mime);
  const filename = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(file.bytes);
});

routes.on(workspaceApi.artifactDownload, (req, res) => {
  owned("artifacts", req.params.id, res.locals.owner);
  if (res.locals.bearer && res.req.method !== "HEAD") recordCardRead(res.locals.owner, res.locals.bearer.tokenId, ["a:" + req.params.id]);
  res.redirect(303, "/api/artifacts/" + req.params.id + "/file");
});
