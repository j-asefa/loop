import { Router } from "express";
import { z } from "zod";
import { db, now } from "../db.js";
import { owned, Problem } from "../domain.js";
import { isSubscription } from "../subscriptions.js";
import { briefAttention } from "../mobile-return.js";
import type { Connection } from "../../shared/types.js";
import type {
  BriefPage,
  BriefSource,
  BriefVersion,
} from "../../shared/briefs.js";
import { Cite, type Item } from "./schema.js";
import { resolveCite } from "./cites.js";
import {
  addDecision,
  editItem,
  itemKinds,
  setGoal,
  statuses,
} from "./owner.js";
import { markDue } from "./schedule.js";
import { serveBrief } from "./serve.js";
import {
  assertProject,
  decodeItem,
  publicItem,
  readState,
  type View,
} from "./store.js";

export const briefs = Router();
briefs.param("id", (_req, res, next, project: string) => {
  assertProject(res.locals.owner, project);
  next();
});
const root = "/projects/:id/brief";
const settingsSchema = z
  .object({
    enabled: z.boolean(),
    connectionId: z.string().min(1).max(150).nullable(),
    model: z.string().min(1).max(200).nullable(),
  })
  .strict();

function source(
  owner: string,
  project: string,
  cite: Cite,
): BriefSource | null {
  const resolved = resolveCite(owner, project, cite);
  if (!resolved) return null;
  const thread = resolved.conversation
    ? (db
        .prepare("SELECT id,title FROM conversations WHERE owner_id=? AND id=?")
        .get(owner, resolved.conversation) as
        { id: string; title: string } | undefined)
    : undefined;
  let message =
    resolved.message && thread
      ? (db
          .prepare(
            "SELECT id,created_at FROM messages WHERE owner_id=? AND conversation_id=? AND id=?",
          )
          .get(owner, thread.id, resolved.message) as
          { id: string; created_at: number } | undefined)
      : undefined;
  if (!message && thread && resolved.runId && !resolved.artifact)
    message = db
      .prepare(
        `SELECT id,created_at FROM messages WHERE owner_id=? AND conversation_id=? AND run_id=? AND role IN ('assistant','user')
      AND COALESCE(json_extract(metadata,'$.progress'),0)=0 ORDER BY role='assistant' DESC,created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(owner, thread.id, resolved.runId) as
      { id: string; created_at: number } | undefined;
  return {
    ref: cite.ref,
    title: thread?.title ?? "Saved result",
    conversation: thread?.id ?? null,
    message: message?.id ?? null,
    artifact: resolved.artifact ?? null,
    at:
      resolved.recordedAt ??
      message?.created_at ??
      resolved.runCreatedAt ??
      null,
    excerpt: cite.quote ?? resolved.content.slice(0, 4000),
  };
}
function sources(owner: string, project: string, cites: Cite[]) {
  const result: Record<string, BriefSource> = {};
  for (const cite of cites)
    if (!result[cite.ref]) {
      const resolved = source(owner, project, cite);
      if (resolved) result[cite.ref] = resolved;
    }
  return result;
}
const itemCites = (items: Item[]) =>
  items.flatMap((item) => [
    ...item.cite,
    ...(item.answered_cite ? [item.answered_cite] : []),
  ]);
function readPage(owner: string, project: string): BriefPage {
  return db.transaction(() => {
    const brief = serveBrief(owner, project),
      state = readState(owner, project);
    const attention: BriefPage["attention"] = {};
    const targets = briefAttention(owner, project).targets;
    for (const need of brief.needs_you)
      attention[need.ref] = targets[need.ref] ?? {
        conversation: need.conversation,
        message: null,
      };
    const coverage = db
      .prepare(
        `SELECT count(DISTINCT ref) results,count(DISTINCT conversation_id) threads FROM project_changes
      WHERE owner_id=? AND project_id=? AND kind='result' AND seq<=? AND seq>=?`,
      )
      .get(
        owner,
        project,
        state.basis_through,
        state.unincorporated_before ?? 0,
      ) as { results: number; threads: number };
    const generated = db
      .prepare(
        "SELECT model FROM project_briefs WHERE owner_id=? AND project_id=? AND state='published' AND model IS NOT NULL ORDER BY version DESC LIMIT 1",
      )
      .get(owner, project) as { model: string } | undefined;
    return {
      ...brief,
      settings: {
        enabled: !!state.enabled,
        connectionId: state.connection_id,
        model: state.model,
        lastError: state.last_error,
      },
      sources: sources(owner, project, [
        ...(brief.headline?.cite ?? []),
        ...itemCites([
          ...brief.state,
          ...brief.decisions,
          ...brief.open_questions,
          ...brief.unfinished,
        ]),
      ]),
      attention,
      coverage: { ...coverage, model: generated?.model ?? null },
    };
  })();
}
briefs.get<{ id: string; itemId: string }>(root, (req, res) =>
  res.json(readPage(res.locals.owner, req.params.id)),
);
briefs.get<{ id: string }>(root + "/decision-sources", (req, res) => {
  const owner = res.locals.owner,
    project = req.params.id;
  const candidates = db
    .prepare(
      `SELECT 'res_'||a.id ref,a.updated_at at FROM artifacts a
    JOIN project_change_sources s ON s.source='artifact' AND s.ref=a.id AND s.owner_id=a.owner_id
    WHERE a.owner_id=@owner AND s.project_id=@project AND a.pinned=1 AND a.archived=0
    UNION ALL SELECT (CASE WHEN EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=m.owner_id AND b.message_id=m.id)
      THEN 'saved_' ELSE 'msg_' END)||m.id ref,m.created_at at FROM messages m
    JOIN project_change_sources s ON s.source='message' AND s.ref=m.id AND s.owner_id=m.owner_id
    WHERE m.owner_id=@owner AND s.project_id=@project AND (m.role='user' OR EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=m.owner_id AND b.message_id=m.id))
    ORDER BY at DESC LIMIT 200`,
    )
    .all({ owner, project }) as { ref: string }[];
  const items = candidates
    .flatMap((cite) => {
      const resolved = resolveCite(owner, project, cite);
      if (
        !resolved ||
        !(
          resolved.kind === "saved" ||
          resolved.saved ||
          (resolved.kind === "message" &&
            resolved.role === "user" &&
            !resolved.automated)
        )
      )
        return [];
      return source(owner, project, cite) ?? [];
    })
    .slice(0, 100);
  res.json({ items });
});
briefs.put<{ id: string; itemId: string }>(root + "/settings", (req, res) => {
  const input = settingsSchema.parse(req.body),
    owner = res.locals.owner,
    project = req.params.id;
  db.transaction(() => {
    if (input.connectionId) {
      const connection = owned<Connection>(
        "connections",
        input.connectionId,
        owner,
      );
      if (
        isSubscription(connection) ||
        !["openai", "anthropic"].includes(connection.provider)
      )
        throw new Problem(400, "Choose an API connection for the brief");
      if (connection.status !== "connected")
        throw new Problem(400, "Reconnect this provider first");
      if (
        !input.model ||
        !(JSON.parse(connection.models) as { id: string }[]).some(
          (model) => model.id === input.model,
        )
      )
        throw new Problem(400, "Choose a model from this connection");
    } else if (input.enabled || input.model)
      throw new Problem(400, "Choose an API connection and model");
    db.prepare(
      "INSERT OR IGNORE INTO brief_state(owner_id,project_id) VALUES(?,?)",
    ).run(owner, project);
    const previous = readState(owner, project);
    const changed =
      previous.enabled !== Number(input.enabled) ||
      previous.connection_id !== input.connectionId ||
      previous.model !== input.model;
    if (changed)
      db.prepare(
        `UPDATE brief_state SET enabled=?,connection_id=?,model=?,generation_id=NULL,lease_until=NULL,due_at=NULL,last_error=NULL WHERE owner_id=? AND project_id=?`,
      ).run(
        Number(input.enabled),
        input.connectionId,
        input.model,
        owner,
        project,
      );
    if (input.enabled) markDue(owner, project);
  }).immediate();
  res.json(readPage(owner, project));
});
briefs.put<{ id: string; itemId: string }>(root + "/goal", (req, res) => {
  setGoal(res.locals.owner, req.params.id, req.body);
  res.json(readPage(res.locals.owner, req.params.id));
});
briefs.post<{ id: string; itemId: string }>(root + "/ack", (req, res) => {
  const { version } = z
    .object({
      version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .parse(req.body);
  db.transaction(() => {
    if (version > readState(res.locals.owner, req.params.id).current_version)
      throw new Problem(409, "That brief version is not available");
    db.prepare(
      `INSERT INTO brief_acks(owner_id,project_id,version,at) VALUES(?,?,?,?)
      ON CONFLICT(owner_id,project_id) DO UPDATE SET version=max(version,excluded.version),at=CASE WHEN excluded.version>version THEN excluded.at ELSE at END`,
    ).run(res.locals.owner, req.params.id, version, now());
  }).immediate();
  res.json({ ok: true });
});
briefs.get<{ id: string; itemId: string }>(root + "/items", (req, res) => {
  const input = z
    .object({
      kind: z.enum(itemKinds),
      status: z.string().max(30).optional(),
      before: z.string().max(500).optional(),
    })
    .strict()
    .parse(req.query);
  if (
    input.status &&
    !(statuses[input.kind] as readonly string[]).includes(input.status)
  )
    throw new Problem(400, "Status does not match this item kind");
  let cursor: { version: number; id: string } | null = null;
  if (input.before) {
    try {
      cursor = z
        .object({
          version: z.number().int().nonnegative(),
          id: z.string().min(1).max(150),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(input.before, "base64url").toString()));
    } catch {
      throw new Problem(400, "Invalid item cursor");
    }
  }
  const owner = res.locals.owner,
    project = req.params.id;
  const page = db
    .prepare(
      `SELECT * FROM brief_items WHERE owner_id=@owner AND project_id=@project AND kind=@kind
    AND (@status IS NULL OR status=@status) AND (@version IS NULL OR first_version<@version OR (first_version=@version AND id<@id))
    ORDER BY first_version DESC,id DESC LIMIT 51`,
    )
    .all({
      owner,
      project,
      kind: input.kind,
      status: input.status ?? null,
      version: cursor?.version ?? null,
      id: cursor?.id ?? null,
    }) as Record<string, any>[];
  const items = page.slice(0, 50).map((row) => publicItem(decodeItem(row))),
    last = items.at(-1);
  const replacements: Record<string, string> = {};
  for (const item of items)
    if (item.status === "superseded") {
      const replacement = db
        .prepare(
          "SELECT text FROM brief_items WHERE owner_id=? AND project_id=? AND supersedes=? ORDER BY last_version DESC,id LIMIT 1",
        )
        .get(owner, project, item.id) as { text: string } | undefined;
      if (replacement) replacements[item.id] = replacement.text;
    }
  res.json({
    items,
    before:
      page.length > 50 && last
        ? Buffer.from(
            JSON.stringify({ version: last.first_version, id: last.id }),
          ).toString("base64url")
        : null,
    sources: sources(owner, project, itemCites(items)),
    replacements,
  });
});
briefs.patch<{ id: string; itemId: string }>(
  root + "/items/:itemId",
  (req, res) => {
    editItem(res.locals.owner, req.params.id, req.params.itemId, req.body);
    res.json(readPage(res.locals.owner, req.params.id));
  },
);
briefs.post<{ id: string; itemId: string }>(root + "/items", (req, res) => {
  const itemId = addDecision(res.locals.owner, req.params.id, req.body);
  res
    .status(201)
    .json({ ...readPage(res.locals.owner, req.params.id), itemId });
});
briefs.get<{ id: string; itemId: string }>(root + "/versions", (req, res) => {
  const { before } = z
    .object({ before: z.coerce.number().int().positive().optional() })
    .strict()
    .parse(req.query);
  const rows = db
    .prepare(
      "SELECT version,synth_at,view FROM project_briefs WHERE owner_id=? AND project_id=? AND state='published' AND version<? ORDER BY version DESC LIMIT 51",
    )
    .all(
      res.locals.owner,
      req.params.id,
      before ?? Number.MAX_SAFE_INTEGER,
    ) as { version: number; synth_at: number; view: string }[];
  const items: BriefVersion[] = rows.slice(0, 50).map((row) => ({
    version: row.version,
    at: row.synth_at,
    changes: (JSON.parse(row.view) as View).changes,
  }));
  res.json({ items, before: rows.length > 50 ? items.at(-1)!.version : null });
});
