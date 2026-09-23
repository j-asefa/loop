import { feedRevision, feedUpdates } from "./feed.js";
import {
  isSubscription,
  runtimeAction,
  runtimeConfigured,
} from "./subscriptions.js";
import { setGrants } from "./mcp/routes.js";
import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, createAgent, renameAgent, Problem } from "./domain.js";
import { adapter } from "./providers.js";
import { seal, unseal } from "./secrets.js";
import { submit } from "./agent-runtime.js";
import { transition, type Run } from "./queue.js";
import type { Agent, Connection, Message } from "../shared/types.js";
export const core = Router();
core.get("/bootstrap", (_req, res) =>
  res.json({
    agents: db
      .prepare("SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC")
      .all(res.locals.owner),
    connections: db
      .prepare(
        "SELECT id,provider,label,status,models,metadata FROM connections WHERE owner_id=?",
      )
      .all(res.locals.owner),
    folders: db
      .prepare("SELECT * FROM folders WHERE owner_id=? ORDER BY name")
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
core.post("/connections/:id/reconnect", async (req, res) => {
  const c = owned<Connection>("connections", req.params.id, res.locals.owner),
    secret = z.string().min(8).max(4096).parse(req.body.secret);
  if (isSubscription(c))
    throw new Problem(
      400,
      "Use subscription sign-in to reconnect this account.",
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
  if (isSubscription(c)) await runtimeAction(c, "logout");
  res.json({ ok: true });
});
core.post("/agents", (req, res) =>
  res.status(201).json(
    db.transaction(() => {
      const a = createAgent(res.locals.owner, req.body);
      if (req.body.tools)
        setGrants(
          res.locals.owner,
          a.id,
          z
            .array(
              z.object({
                connectionId: z.string(),
                tools: z.array(z.string()).max(40),
              }),
            )
            .max(20)
            .parse(req.body.tools),
        );
      return a;
    })(),
  ),
);
core.patch("/agents/:id", (req, res) => {
  const owner = res.locals.owner,
    agent = owned<Agent>("agents", req.params.id, owner);
  if (req.body.name !== undefined) renameAgent(owner, agent.id, req.body.name);
  if (req.body.instructions !== undefined)
    db.prepare("UPDATE agents SET instructions=? WHERE id=?").run(
      z.string().max(12000).parse(req.body.instructions),
      agent.id,
    );
  if (req.body.model !== undefined) {
    const c = owned<Connection>(
      "connections",
      agent.connection_id || "",
      owner,
    );
    if (
      !JSON.parse(c.models).some((m: { id: string }) => m.id === req.body.model)
    )
      throw new Problem(400, "Model unavailable on this connection");
    db.prepare("UPDATE agents SET model=? WHERE id=?").run(
      req.body.model,
      agent.id,
    );
  }
  res.json(owned("agents", agent.id, owner));
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
      input: z.string().trim().min(1).max(30000),
      idempotencyKey: z.string().min(8).max(150),
      folderId: z.string().optional(),
    })
    .parse(req.body);
  res.status(202).json(submit(res.locals.owner, d));
});
core.post("/runs/:id/:action", (req, res) => {
  const run = owned<Run>("runs", req.params.id, res.locals.owner);
  const action = req.params.action;
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
      view: z.enum(["all", "prompts", "files"]).default("all"),
    })
    .parse(req.query);
  if (options.agent) owned("agents", options.agent, res.locals.owner);
  res.json(feedUpdates(res.locals.owner, options));
});
core.get("/feed", (req, res) => {
  const revision = feedRevision(res.locals.owner);
  const cursor = z.coerce.number().min(0).catch(0).parse(req.query.before),
    limit = 40;
  const params: unknown[] = [res.locals.owner];
  let where = "a.owner_id=? AND a.archived=0";
  if (req.query.agent) {
    owned("agents", String(req.query.agent), res.locals.owner);
    where += " AND a.agent_id=?";
    params.push(req.query.agent);
  }
  if (cursor) {
    where += " AND a.rowid<?";
    params.push(cursor);
  }
  if (req.query.view === "prompts") {
    const values: any[] = [res.locals.owner];
    let filter = "m.owner_id=? AND m.role='user'";
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
        `SELECT m.*,m.rowid cursor,a.name,a.provider FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN agents a ON a.id=c.agent_id WHERE ${filter} ORDER BY m.rowid DESC LIMIT 40`,
      )
      .all(...values) as any[];
    res.json({
      revision,
      items: rows,
      next: rows.length === 40 ? rows.at(-1).cursor : null,
    });
    return;
  }
  if (req.query.view === "files")
    where +=
      " AND a.kind IN ('file','image','code','table','diagram','chart','workflow')";
  const items = db
    .prepare(
      `SELECT a.*,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,a.rowid AS cursor,g.name,g.provider FROM artifacts a LEFT JOIN agents g ON g.id=a.agent_id WHERE ${where} ORDER BY a.rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as { cursor: number }[];
  res.json({
    revision,
    items,
    next: items.length === limit ? items.at(-1)!.cursor : null,
  });
});
core.get("/conversations/:id", (req, res) => {
  const c = owned("conversations", req.params.id, res.locals.owner);
  let before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  if (req.query.message) {
    const m = owned<any>(
      "messages",
      String(req.query.message),
      res.locals.owner,
    );
    if (m.conversation_id !== req.params.id)
      throw new Problem(404, "Message not found");
    const anchor = db
      .prepare("SELECT rowid r FROM messages WHERE id=?")
      .get(m.id) as { r: number };
    before = anchor.r + 25;
  }
  const items = db
    .prepare(
      "SELECT *,rowid AS cursor FROM messages WHERE owner_id=? AND conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 50",
    )
    .all(res.locals.owner, req.params.id, before) as { cursor: number }[];
  res.json({
    conversation: c,
    messages: items.reverse(),
    next: items.length === 50 ? items[0].cursor : null,
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
