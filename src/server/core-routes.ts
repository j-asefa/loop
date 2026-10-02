import { environment, hub, workerRequest } from "./hapi/environments.js";
import {
  isNativeConnection,
  NATIVE_CONNECTION_SQL,
} from "./native-connections.js";
import { nativeSessions } from "./native-sessions.js";
import {
  feedRevision,
  feedUpdates,
  feedOutputSql,
  fileArtifactSql,
  projectFolders,
} from "./feed.js";
import { agentTraces } from "./traces.js";
import { personalHistory } from "./personal-history.js";
import { readProfile, saveProfile } from "./user-profile.js";
import { agentMessages } from "./agent-messages.js";
import { conversationMessages } from "./conversation-messages.js";
import { dismissRun } from "./run-attention.js";
import { conversationReturnState } from "./mobile-return.js";
import {
  isSubscription,
  runtimeAction,
  runtimeConfigured,
  runtimeWorkspaceKey,
} from "./subscriptions.js";
import { Router } from "express";
import { z } from "zod";
import { db, emit, id, now } from "./db.js";
import {
  owned,
  renameAgent,
  Problem,
  agentInput,
  validateEffort,
} from "./domain.js";
import { createWithPrompt } from "./agent-creation.js";
import { suggestAgentName } from "./agent-names.js";
import { adapter } from "./providers.js";
import { seal, unseal } from "./secrets.js";
import { submit } from "./agent-runtime.js";
import { attachmentIds } from "./uploads.js";
import { transition, type Run } from "./queue.js";
import type { Agent, Connection, Message } from "../shared/types.js";
import { listTeams, teamFilter } from "./teams.js";
import { nativeCancel, dispatchFor } from "./hapi/adapter.js";
export const core = Router();
core.get("/bootstrap", (_req, res) =>
  res.json({
    teams: listTeams(res.locals.owner),
    agents: db
      .prepare("SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC")
      .all(res.locals.owner),
    connections: db
      .prepare(
        "SELECT id,provider,label,status,models,metadata FROM connections WHERE owner_id=?",
      )
      .all(res.locals.owner),
    folders: db
      .prepare(
        "SELECT f.*,p.path FROM folders f LEFT JOIN project_paths p ON p.folder_id=f.id WHERE f.owner_id=? ORDER BY f.name",
      )
      .all(res.locals.owner),
    identityProviders: process.env.GITHUB_CLIENT_ID ? ["github"] : [],
    capabilities: {
      codex: runtimeConfigured(),
      claudeLogin: runtimeConfigured(),
    },
  }),
);
const connectionInput = z.object({
  provider: z.enum(["openai", "anthropic"]),
  label: z.string().trim().min(1).max(80),
  secret: z.string().trim().min(8).max(4096),
});
core.post("/connections", async (req, res) => {
  const d = connectionInput.parse(req.body);
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
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    record,
    res.locals.owner,
    d.provider,
    d.label,
    seal(d.secret, res.locals.owner),
    "connected",
    JSON.stringify(models),
    JSON.stringify({
      billing: "API-billed",
      scope:
        "Models available to this key; consumer chat history is not included",
    }),
    now(),
  );
  res.json({ id: record, models });
});
core.post("/connections/:id/refresh", async (req, res) => {
  const c = owned<Connection>("connections", req.params.id, res.locals.owner);
  if (isNativeConnection(c)) {
    const harness = JSON.parse(c.metadata).loopHarness;
    return res.json(
      await nativeSessions.enable(nativeSessions.registration(harness)),
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
    db.prepare(
      "UPDATE connections SET models=?,status='connected' WHERE id=?",
    ).run(JSON.stringify(models), c.id);
    res.json({ models });
  } catch {
    db.prepare(
      "UPDATE connections SET status='needs_reconnect' WHERE id=?",
    ).run(c.id);
    throw new Problem(
      422,
      "Connection could not be refreshed. Reconnect with a valid API key.",
    );
  }
});
core.get("/connections/:id/models", async (req, res) => {
  const c = owned<Connection>("connections", req.params.id, res.locals.owner);
  if (c.status !== "connected")
    throw new Problem(409, "Reconnect this provider first");
  let models;
  if (isNativeConnection(c)) {
    const harness = JSON.parse(c.metadata).loopHarness;
    await nativeSessions.enable(nativeSessions.registration(harness));
    models = JSON.parse(
      owned<Connection>("connections", c.id, res.locals.owner).models,
    );
  } else if (isSubscription(c)) {
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
    JSON.stringify(catalog),
    c.id,
  );
  res.json({ models: catalog });
});
core.post("/connections/:id/reconnect", async (req, res) => {
  const c = owned<Connection>("connections", req.params.id, res.locals.owner),
    secret = z.string().min(8).max(4096).parse(req.body.secret);
  if (isSubscription(c))
    throw new Problem(
      400,
      "Use subscription sign-in to reconnect this account.",
    );
  if (isSubscription(c))
    throw new Problem(
      400,
      "Refresh this subscription through its sign-in status.",
    );
  try {
    const models = await adapter(c.provider).models(secret);
    db.prepare(
      "UPDATE connections SET secret=?,models=?,status='connected' WHERE id=?",
    ).run(seal(secret, res.locals.owner), JSON.stringify(models), c.id);
    res.json({ ok: true });
  } catch {
    throw new Problem(422, "Could not validate this API key");
  }
});
core.delete("/connections/:id", async (req, res) => {
  const c = owned<Connection>("connections", req.params.id, res.locals.owner);
  db.prepare(
    "UPDATE connections SET secret='',status='disconnected' WHERE id=?",
  ).run(req.params.id);
  const metadata = JSON.parse(c.metadata);
  if (metadata.backend === "hapi")
    await workerRequest(
      environment(res.locals.owner, metadata.environmentId),
      "/logout",
      { flavor: metadata.flavor },
    );
  else if (isSubscription(c)) await runtimeAction(c, "logout");
  res.json({ ok: true });
});
core.get("/agents/suggest-name", (_req, res) =>
  res.set("Cache-Control", "no-store").json({ name: suggestAgentName() }),
);
core.post("/agents", (req, res) =>
  res.status(201).json(createWithPrompt(res.locals.owner, req.body)),
);
core.patch("/agents/:id", (req, res) => {
  const result = db
    .transaction(() => {
      const owner = res.locals.owner,
        agent = owned<Agent>("agents", req.params.id, owner);
      if (req.body.retired !== undefined) {
        const retired = z.boolean().parse(req.body.retired);
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
        const c = owned<Connection>(
          "connections",
          z.string().parse(req.body.connectionId ?? agent.connection_id ?? ""),
          owner,
        );
        if (c.status !== "connected")
          throw new Problem(409, "Reconnect this provider first");
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
        if (!JSON.parse(c.models).some((m: { id: string }) => m.id === model))
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
      return owned("agents", agent.id, owner);
    })
    .immediate();
  res.json(result);
});
core.get("/agents/:id/harness", async (req, res) => {
  const agent = owned<Agent>("agents", req.params.id, res.locals.owner);
  if (!agent.connection_id)
    throw new Problem(409, "Connect a provider to this agent first.");
  const connection = owned<Connection>(
    "connections",
    agent.connection_id,
    res.locals.owner,
  );
  if (!isSubscription(connection)) {
    res.json({
      available: false,
      commands: [],
      message:
        "Commands and skills come from a Codex or Claude Code runtime. This agent uses an API connection.",
    });
    return;
  }
  if (connection.status !== "connected")
    throw new Problem(
      409,
      "Reconnect this agent’s provider to load commands and skills.",
    );
  const native = JSON.parse(connection.metadata);
  if (native.backend === "hapi") {
    const session = db
      .prepare(
        "SELECT s.* FROM native_sessions s JOIN conversations c ON c.id=s.conversation_id WHERE c.agent_id=? AND s.owner_id=? AND s.hub_session_id IS NOT NULL ORDER BY s.created_at DESC LIMIT 1",
      )
      .get(agent.id, res.locals.owner) as any;
    if (!session) {
      res.json({
        available: false,
        commands: [],
        message:
          "Start a native conversation to discover commands and skills from that environment.",
      });
      return;
    }
    const client = hub(environment(res.locals.owner, session.environment_id));
    const [commands, skills] = await Promise.all([
      client.request(
        "/api/sessions/" + session.hub_session_id + "/slash-commands",
      ),
      client.request("/api/sessions/" + session.hub_session_id + "/skills"),
    ]);
    res.json({
      available: true,
      commands: [
        ...(commands.commands || []).map((c: any) => ({
          ...c,
          token: "/" + c.name.replace(/^\//, ""),
          kind: "command",
        })),
        ...(skills.skills || []).map((c: any) => ({
          ...c,
          token: (native.flavor === "codex" ? "$" : "/") + c.name,
          kind: "skill",
        })),
      ],
      runtime: native.flavor,
    });
    return;
  }
  const catalog = isNativeConnection(connection)
    ? await nativeSessions.catalog(
        agent,
        z.string().uuid().optional().parse(req.query.conversation),
      )
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
core.get("/agents/:id/traces", (req, res) => {
  const before = z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .parse(req.query.before);
  const runId = z.string().min(1).max(100).optional().parse(req.query.run);
  res.json(agentTraces(res.locals.owner, req.params.id, before, runId));
});
core.get("/me/profile", (_req, res) => {
  res.json(readProfile(res.locals.owner));
});
core.put("/me/profile", (req, res) => {
  res.json(saveProfile(res.locals.owner, req.body));
});
core.get("/me/prompts", (req, res) => {
  const before = z.string().min(1).max(512).optional().parse(req.query.before);
  const q = z.string().trim().max(200).optional().parse(req.query.q);
  res.json(personalHistory(res.locals.owner, before, q || undefined));
});
core.get("/agents/:id/messages", (req, res) => {
  const before = z.string().min(1).max(512).optional().parse(req.query.before);
  res.json(agentMessages(res.locals.owner, req.params.id, before));
});
core.get("/agents/:id", (req, res) => {
  const a = owned<Agent>("agents", req.params.id, res.locals.owner);
  res.json({
    agent: a,
    runs: db
      .prepare(
        "SELECT * FROM runs WHERE owner_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner, a.id),
    conversations: db
      .prepare(
        "SELECT * FROM conversations WHERE owner_id=? AND agent_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner, a.id),
  });
});
core.post("/runs", (req, res) => {
  const d = z
    .object({
      agentId: z.string(),
      conversationId: z.string().optional(),
      replyToMessageId: z.string().min(1).max(150).optional(),
      input: z.string().trim().min(1).max(30000),
      attachmentIds,
      idempotencyKey: z.string().min(8).max(150),
      folderId: z.string().min(1).nullable().optional(),
      // Queue after the current run instead of steering it.
      queue: z.boolean().optional(),
    })
    .parse(req.body);
  const { queue, ...data } = d;
  res
    .status(202)
    .json(
      submit(res.locals.owner, { ...data, steer: !queue, personal: true }),
    );
});
core.post("/runs/:id/:action", async (req, res) => {
  const run = owned<Run>("runs", req.params.id, res.locals.owner);
  const action = req.params.action;
  if (action === "cancel" && (await nativeCancel(run))) {
    res.json({ ok: true, cancellationRequested: true });
    return;
  }
  if (["retry", "resume", "pause"].includes(action) && dispatchFor(run.id))
    throw new Problem(
      409,
      "Reconcile native execution before changing this run. An uncertain action cannot be replayed.",
    );
  if (
    action === "pause" &&
    ["running", "awaiting_approval"].includes(run.state) &&
    (db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id) ||
      db
        .prepare(
          `SELECT 1 FROM connections c WHERE c.id=json_extract(?,'$.connectionId') AND ${NATIVE_CONNECTION_SQL}`,
        )
        .get(run.payload))
  )
    throw new Problem(
      409,
      "This harness cannot suspend an active native turn. Interrupt this run, then send a follow-up; other agents keep running.",
    );
  if (action === "dismiss") {
    res.json(dismissRun(res.locals.owner, run.id));
    return;
  }
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
      submit(res.locals.owner, {
        agentId: run.agent_id,
        conversationId: run.conversation_id || undefined,
        input: run.input,
        idempotencyKey: d.idempotencyKey,
        attachmentIds: JSON.parse(run.payload).attachmentIds || [],
        replyTo: JSON.parse(run.payload).replyTo,
      }),
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
    action === "cancel"
      ? "cancelled"
      : action === "pause"
        ? run.state === "queued"
          ? "paused"
          : "pausing"
        : action === "resume"
          ? "queued"
          : null;
  if (!next || !transition(run, next))
    throw new Problem(409, "That action is not available in the current state");
  if (action === "cancel") {
    const children = db
      .prepare(
        "SELECT r.* FROM delegations d JOIN runs r ON r.id=d.child_run_id WHERE d.parent_run_id=?",
      )
      .all(run.id) as Run[];
    children.forEach((child) => transition(child, "cancelled"));
  }
  if (
    action === "pause" &&
    (run as any).worker_id === null &&
    run.state === "running"
  )
    transition(run, "paused");
  if (action === "cancel" && run.kind === "workflow") {
    const children = db
      .prepare(
        "SELECT r.* FROM workflow_steps s JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=?",
      )
      .all(run.id) as Run[];
    children.forEach((child) => transition(child, "cancelled"));
  }
  res.json({ ok: true });
});
core.get("/feed/updates", (req, res) => {
  const number = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const options = z
    .object({
      after: number,
      through: number,
      agent: z.string().optional(),
      folder: z.string().optional(),
      view: z.enum(["all", "prompts", "files"]).default("all"),
      saved: z
        .enum(["1", "0"])
        .optional()
        .transform((v) => v === "1"),
    })
    .parse(req.query);
  if (options.agent) owned("agents", options.agent, res.locals.owner);
  if (options.folder) owned("folders", options.folder, res.locals.owner);
  const teams = teamFilter(req.query.teams, res.locals.owner);
  res.json(feedUpdates(res.locals.owner, { ...options, teams }));
});
core.get("/feed", (req, res) => {
  const saved = req.query.saved === "1";
  const revision = feedRevision(res.locals.owner);
  const teams = teamFilter(req.query.teams, res.locals.owner);
  const cursor = z.coerce.number().min(0).catch(0).parse(req.query.before),
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
    where += " AND a.folder_id IN (SELECT value FROM json_each(?))";
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
    const values: any[] = [res.locals.owner];
    let filter = "m.owner_id=? AND m.role='user'";
    if (teams.length) {
      filter += " AND c.team_id IN (" + teams.map(() => "?").join(",") + ")";
      values.push(...teams);
    }
    if (req.query.folder) {
      filter +=
        " AND EXISTS (SELECT 1 FROM runs fr WHERE fr.id=m.run_id AND json_extract(fr.payload,'$.folderId') IN (SELECT value FROM json_each(?)))";
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
      .all(...values) as any[];
    res.json({
      revision,
      items: rows,
      next: rows.length === 40 ? rows.at(-1).cursor : null,
    });
    return;
  }
  if (saved) where += ` AND ${fileArtifactSql}`;
  else if (req.query.view === "files")
    where += ` AND ${fileArtifactSql} AND a.kind IN ('file','image','code','table','diagram','chart','workflow')`;
  else where += ` AND ${feedOutputSql}`;
  const items = db
    .prepare(
      `SELECT a.*,r.state run_state,r.error run_error,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,p.sequence AS cursor,g.name,g.provider,(SELECT team_id FROM conversations WHERE id=a.conversation_id) team_id FROM artifacts a JOIN ${saved ? "artifact_bookmarks" : "artifact_publications"} p ON p.artifact_id=a.id LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id LEFT JOIN agents g ON g.id=a.agent_id WHERE ${where} ORDER BY p.sequence DESC LIMIT ?`,
    )
    .all(...params, limit) as { cursor: number }[];
  res.json({
    revision,
    items,
    next: items.length === limit ? items.at(-1)!.cursor : null,
  });
});
core.patch("/feed/:id", (req, res) => {
  const item = owned<any>("artifacts", req.params.id, res.locals.owner);
  const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
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
core.get("/conversations/:id", (req, res) => {
  const c = owned("conversations", req.params.id, res.locals.owner);
  const before = z.string().max(512).optional().parse(req.query.before);
  const anchor = z.string().max(150).optional().parse(req.query.message);
  res.json({
    conversation: c,
    ...conversationMessages(res.locals.owner, req.params.id, before, anchor),
    ...conversationReturnState(res.locals.owner, req.params.id),
  });
});
core.get("/messages/:id", (req, res) =>
  res.json(owned<Message>("messages", req.params.id, res.locals.owner)),
);
core.get("/messages", (req, res) => {
  const q = z
    .string()
    .max(500)
    .parse(req.query.q || "");
  res.json(
    db
      .prepare(
        "SELECT * FROM messages WHERE owner_id=? AND instr(lower(content),lower(?))>0 ORDER BY created_at DESC LIMIT 50",
      )
      .all(res.locals.owner, q),
  );
});
