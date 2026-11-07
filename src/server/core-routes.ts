import * as agentsQueries from "./sql/agents.js";
import * as connectionsQueries from "./sql/connections.js";
import * as foldersQueries from "./sql/folders.js";
import * as teamsQueries from "./sql/teams.js";
import * as conversationsQueries from "./sql/conversations.js";
import * as nativeDispatchQueries from "./sql/native-dispatch.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as runsQueries from "./sql/runs.js";
import * as messagesQueries from "./sql/messages.js";
import { passiveWorkspaceRead } from "./workspace-read-context.js";
import { submitTokenWrite, runControlTokenWrite, approvalTokenWrite } from "./token-write-policies.js";
import * as approvalsQueries from "./sql/approvals.js";
import { recordCardRead, tokenResultPage } from "./card-tokens.js";
import { registrar, projectResponse } from "./registrar.js";
import { workspaceApi, PublicAgent, PublicConnection, PublicFolder, PublicMessage, ResultItem } from "../shared/workspace-api.js";

import { InvalidRow, parseConnectionControl, ConnectionModels, ConnectionMetadata, runResponse, messageResponse } from "./row-schemas.js";
import type { QueryRow } from "./query-records.js";


import { projectionSnapshot } from "./projection-snapshot.js";
import { writeConnectionStatus } from "./connection-status.js";
import { localArtifact } from "./published-files.js";
import { FILE_DOWNLOAD_POLICY, sendHtmlPreview } from "./file-preview.js";
import {
  isNativeConnection,
} from "./native-connections.js";
import { executionRequest } from "./execution-client.js";
import { nativeSessions } from "./native-sessions.js";
import { hostEnvironmentName } from "./execution-location.js";
import {
  resultsRevision,
  resultsUpdates,
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
} from "./subscriptions.js";

import { z } from "zod";
import { db, emit, id, now } from "./db.js";
import { owned, ownedAgent, ownedApproval, ownedConversation, ownedArtifact, ownedConnection, ownedMessage, ownedRun, renameAgent, Problem, agentInput, validateEffort } from "./domain.js";
import { createWithPrompt } from "./agent-creation.js";
import { suggestAgentName } from "./agent-names.js";
import { adapter } from "./providers.js";
import { seal, unseal } from "./secrets.js";
import { nextTurnConnection, submit } from "./agent-runtime.js";
import { activeRun } from "./steering.js";
import { transition } from "./queue.js";
import { assertEffect, inheritEffect } from "./effect-authority.js";

import { assertTeamRestoreCapacity, listTeams, teamFilter } from "./teams.js";
import { decide } from "./approvals.js";
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
    agents: agentsQueries.forOwner(db, res.locals.owner) as z.input<typeof PublicAgent>[],
    connections: connectionsQueries.publicCatalog(db, res.locals.owner) as z.input<typeof PublicConnection>[],
    folders: foldersQueries.withProjects(db, res.locals.owner) as z.input<typeof PublicFolder>[],
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
  writeConnectionStatus(record, () => connectionsQueries.insert(db, record, res.locals.owner, d.provider, d.label, seal(d.secret, res.locals.owner), "connected", JSON.stringify(ConnectionModels.parse(models)), JSON.stringify(ConnectionMetadata.parse({
      billing: "API-billed",
      scope:
        "Models available to this key; consumer chat history is not included",
    })), now()));
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
    writeConnectionStatus(c.id, () => connectionsQueries.connectedModels(db, JSON.stringify(ConnectionModels.parse(models)), c.id));
    res.json({ models });
  } catch {
    writeConnectionStatus(c.id, () => connectionsQueries.needsReconnect(db, c.id));
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
  if (isSubscription(c))
    throw new Problem(409, "This connection has no runtime on this computer.");
  const models = await adapter(c.provider).models(
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
  connectionsQueries.models(db, JSON.stringify(ConnectionModels.parse(catalog)), c.id);
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
    writeConnectionStatus(c.id, () => connectionsQueries.reconnect(db, seal(secret, res.locals.owner), JSON.stringify(ConnectionModels.parse(models)), c.id));
    res.json({ ok: true });
  } catch {
    throw new Problem(422, "Could not validate this API key");
  }
});
routes.on(workspaceApi.connectionDisconnect, async (req, res) => {
  const raw = connectionsQueries.ownedForRevocation(db, req.params.id, res.locals.owner);
  if (!raw) throw new Problem(404, "Item not found");
  let c: ReturnType<typeof parseConnectionControl> | undefined;
  try { c = parseConnectionControl(raw); }
  catch (error) { if (!(error instanceof InvalidRow)) throw error; }
  // Revocation must work for an unavailable row, without using its invalid
  // routing for an external logout or repairing it into an executable default.
  writeConnectionStatus(req.params.id, () => connectionsQueries.disconnect(db, req.params.id, res.locals.owner));
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
        agentsQueries.retire(db, retired ? agent.retired_at || now() : null, agent.id, owner);
      }
      if (req.body.folderId !== undefined) {
        const folderId = z.string().min(1).nullable().parse(req.body.folderId);
        if (folderId) owned("folders", folderId, owner);
        agentsQueries.folder(db, folderId, agent.id, owner);
      }
      if (req.body.name !== undefined)
        renameAgent(owner, agent.id, req.body.name);
      if (req.body.instructions !== undefined)
        agentsQueries.instructions(db, z.string().max(12000).parse(req.body.instructions), agent.id);
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
        agentsQueries.configure(db, c.id, c.provider, model, effort || null, agent.id);
        if (c.id !== agent.connection_id)
          teamsQueries.clearManagerConversation(db, owner, agent.id);
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
  if (!isNativeConnection(connection)) {
    res.json({
      available: false,
      commands: [],
      message:
        "Commands and skills come from a Codex or Claude Code runtime. This agent uses an API connection.",
    });
    return;
  }
  // The authority validates its own catalog; the response keeps its fields.
  const catalog: any = await executionRequest("native.catalog", { agentId: agent.id, conversationId: conversationKey }, { owner: res.locals.owner });
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
    runs: runsQueries.forAgent(db, res.locals.owner, a.id) as z.input<typeof workspaceApi.agentDetail.response>["runs"],
    conversations: conversationsQueries.forAgent(db, res.locals.owner, a.id) as z.input<typeof workspaceApi.agentDetail.response>["conversations"],
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
    (nativeDispatchQueries.exists(db, run.id) ||
      connectionsQueries.nativeOwned(db, run.payload.connectionId ?? null, run.owner_id))
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
    const agentId = run.agent_id;
    const d = z
      .object({ idempotencyKey: z.string().min(8).max(150) })
      .parse(req.body);
    const replacement = db.transaction(() => {
      assertEffect(run.owner_id, "run", run.id);
      const replacement = submit(res.locals.owner, {
        agentId,
        conversationId: run.conversation_id || undefined,
        input: run.input,
        idempotencyKey: d.idempotencyKey,
        attachmentIds: run.payload.attachmentIds || [],
        replyTo: run.payload.replyTo,
      });
      inheritEffect(run.owner_id, "run", run.id, replacement.id);
      return replacement;
    }).immediate();
    res.json(runResponse(replacement));
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
  if (teams.length) {
    params.push(res.locals.owner, ...teams);
  }
  if (req.query.folder) {
    owned("folders", String(req.query.folder), res.locals.owner);
    params.push(
      JSON.stringify(
        projectFolders(res.locals.owner, String(req.query.folder)),
      ),
    );
  }
  if (req.query.agent) {
    owned("agents", String(req.query.agent), res.locals.owner);
    params.push(req.query.agent);
  }
  if (cursor) {
    params.push(cursor);
  }
  if (!saved && req.query.view === "prompts") {
    const values: unknown[] = [res.locals.owner];
    if (teams.length) {
      values.push(...teams);
    }
    if (req.query.folder) {
      values.push(
        JSON.stringify(
          projectFolders(res.locals.owner, String(req.query.folder)),
        ),
      );
    }
    if (req.query.agent) {
      values.push(req.query.agent);
    }
    if (cursor) {
      values.push(cursor);
    }
    const rows = messagesQueries.promptPage(db, {teamCount:teams.length, folder:!!req.query.folder, agent:!!req.query.agent, cursor:!!cursor}, values) as z.input<typeof ResultItem>[];
    res.json(tokenResultPage(res.locals.owner, res.locals.bearer?.tokenId,
      projectResponse(workspaceApi.results, {
        revision, items: rows, next: rows.length === 40 ? rows.at(-1)!.cursor : null,
      }), "a:", res.req.method !== "HEAD"));
    return;
  }
  const items = artifactsQueries.page(db, {saved, files:req.query.view === "files", teamCount:teams.length, folder:!!req.query.folder, agent:!!req.query.agent, cursor:!!cursor}, params, limit) as z.input<typeof ResultItem>[];
  res.json(tokenResultPage(res.locals.owner, res.locals.bearer?.tokenId,
    projectResponse(workspaceApi.results, {
      revision, items, next: items.length === limit ? items.at(-1)!.cursor : null,
    }), "a:", res.req.method !== "HEAD"));
}, { wrap: handler => projectionSnapshot(handler, { bearerWrites: true }) });
routes.on(workspaceApi.resultUpdate, (req, res) => {
  const item = ownedArtifact(req.params.id, res.locals.owner);
  const { hidden } = req.body;
  artifactsQueries.feedHidden(db, Number(hidden), item.id, res.locals.owner);
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
    messagesQueries.search(db, res.locals.owner, q) as z.input<typeof PublicMessage>[],
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
  res.setHeader("Content-Security-Policy", FILE_DOWNLOAD_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(file.bytes);
});

routes.on(workspaceApi.artifactDownload, (req, res) => {
  owned("artifacts", req.params.id, res.locals.owner);
  if (res.locals.bearer && res.req.method !== "HEAD") recordCardRead(res.locals.owner, res.locals.bearer.tokenId, ["a:" + req.params.id]);
  res.redirect(303, "/api/artifacts/" + req.params.id + "/file");
});
routes.on(workspaceApi.approvals, (req, res) => {
  const teams = teamFilter(req.query.teams, res.locals.owner);
  res.json(
    approvalsQueries.pendingTeams(db, res.locals.owner, teams) as z.input<
      typeof workspaceApi.approvals.response
    >,
  );
});
routes.on(
  workspaceApi.approval,
  (req, res) => {
    ownedApproval(req.params.id, res.locals.owner);
    res.json(decide(res.locals.owner, req.params.id, req.body.decision));
  },
  { tokenWrite: approvalTokenWrite },
);
