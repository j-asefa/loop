import { readMessageMetadata } from "../shared/message-metadata.js";
import { z } from "zod";
import { ftsQuery } from "../shared/search-excerpt.js";
import { workspaceLink } from "../shared/workspace-links.js";
import * as memoryPolicyQueries from "./sql/memory-policy.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as memorySourcesQueries from "./sql/memory-sources.js";
import * as memoryNoteVersionsQueries from "./sql/memory-note-versions.js";
import * as memoryFtsQueries from "./sql/memory-fts.js";
import * as memoryReceiptsQueries from "./sql/memory-receipts.js";
import * as messagesQueries from "./sql/messages.js";
import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";
import type { QueryRow } from "./query-records.js";

import { db, id, now } from "./db.js";
import {
  ownedArtifact,
  ownedConversation,
  ownedFolder,
  ownedMemorySource,
  ownedRun,
  Problem,
} from "./domain.js";
import { createHash } from "node:crypto";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function enabled(
  owner: string,
  scope: string,
  fallback = true,
): boolean {
  if (scope === "workspace" && process.env.LOOP_MEMORY_ENABLED === "0")
    return false;
  const p = memoryPolicyQueries.enabled(db, owner, scope);
  return p ? p.enabled === 1 : fallback;
}
function eligible(s: any) {
  if (
    s.tombstone ||
    !s.eligible ||
    !enabled(s.owner_id, "workspace") ||
    (s.project_id && !enabled(s.owner_id, "project:" + s.project_id))
  )
    return false;
  if (s.kind === "artifact") {
    const artifact = artifactsQueries.pinned(db, s.source_id, s.owner_id);
    if (
      !artifact ||
      !enabled(s.owner_id, "artifact:" + s.source_id, !!artifact.pinned)
    )
      return false;
  }
  if (s.conversation_id) {
    if (!enabled(s.owner_id, "conversation:" + s.conversation_id, false))
      return false;
    if (s.message_id) {
      const m = messagesQueries.ownedMetadata(db, s.message_id, s.owner_id);
      if (!m || readMessageMetadata(m.metadata).superseded) return false;
    }
  }
  return true;
}
function putSource(s: any) {
  const sourceId = digest(s.owner_id + ":" + s.kind + ":" + s.source_id);
  const hash = digest(
    JSON.stringify([s.content, s.project_id, s.eligible, s.title]),
  );
  const old = memorySourcesQueries.get(db, sourceId);
  if (old?.tombstone || old?.content_hash === hash) return;
  const revision = (old?.revision || 0) + 1;
  memorySourcesQueries.upsert(
    db,
    sourceId,
    s.owner_id,
    s.project_id || null,
    s.kind,
    s.source_id,
    s.conversation_id || null,
    s.message_id || null,
    s.agent_id || null,
    s.origin,
    s.role,
    revision,
    hash,
    s.content,
    s.title,
    s.eligible ? 1 : 0,
    s.created_at,
    now(),
  );
  memorySourcesQueries.setComplete(db, s.complete === false ? 0 : 1, sourceId);
  if (s.kind === "note")
    memoryNoteVersionsQueries.insert(
      db,
      sourceId,
      revision,
      s.title,
      s.content,
      now(),
    );
}
export function captureMemory() {
  db.transaction(() => {
    // Match the owner-leading unique key: without the owner predicate this
    // correlated lookup scans every saved source for every message, blocking
    // the companion's API and WebSocket heartbeats on each background pass.
    const rows = messagesQueries.memoryCandidates(
      db,
    ) as (QueryRow<"messages"> & {
      state: string | null;
      project_id: string | null;
      title: string;
      agent_id: string | null;
      origin?: string;
    })[];
    for (const m of rows) {
      const meta = readMessageMetadata(m.metadata);
      const include =
        !meta.partial &&
        !meta.superseded &&
        (m.role === "user" || !m.state || m.state === "completed");
      if (!m.content.trim() || m.content.length > 100000) continue;
      putSource({
        ...m,
        kind: "message",
        source_id: m.id,
        message_id: m.id,
        origin: m.origin || "loop",
        eligible: include,
        role: m.role,
        complete: !meta.truncated,
      });
    }
    const artifacts = artifactsQueries.memoryCandidates(db);
    for (const a of artifacts)
      if (["markdown", "note", "text"].includes(a.kind))
        putSource({
          ...a,
          kind: "artifact",
          source_id: a.id,
          project_id: a.folder_id,
          role: "note",
          origin: "loop",
          eligible: true,
          conversation_id: null,
        });
  }).immediate();
}
function readMemory(
  owner: string,
  sourceId: string,
  revision?: number,
  project?: string | null,
) {
  const s = ownedMemorySource(sourceId, owner);
  if (
    !eligible(s) ||
    (revision !== undefined && s.revision !== revision) ||
    (project !== undefined &&
      s.project_id !== project &&
      !(s.kind === "note" && !s.project_id))
  )
    throw new Problem(
      404,
      "Memory source is unavailable or its revision changed",
    );
  return {
    ...s,
    content: s.content.slice(0, 12000),
    truncated: s.content.length > 12000,
    link: s.conversation_id
      ? workspaceLink({
          conversation: s.conversation_id,
          message: s.message_id,
        })
      : s.kind === "artifact"
        ? workspaceLink({ artifact: s.source_id })
        : workspaceLink({ memory: s.id }),
  };
}
export async function searchMemory(
  owner: string,
  project: string | null,
  query: string,
) {
  if (
    !enabled(owner, "workspace") ||
    (project && !enabled(owner, "project:" + project))
  )
    return { mode: "disabled", sources: [] };
  const candidates: { id: string; revision: number }[] = [];
  const stop = new Set(
    "a an the is are was were do does did in on at to of for and or it this that what which who how we our my earlier".split(
      " ",
    ),
  );
  const match = ftsQuery(query, { limit: 24, exclude: stop });
  if (match) {
    const lexical = memoryFtsQueries.search(
      db,
      `content:(${match})`,
      owner,
      project,
    );
    candidates.push(...lexical);
  }
  const seen = new Set(),
    sources: any[] = [];
  let characters = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    try {
      const s = readMemory(owner, candidate.id, candidate.revision, project);
      const excerpt = s.content.slice(0, Math.min(1100, 5500 - characters));
      if (!excerpt) break;
      characters += excerpt.length;
      sources.push({
        id: s.id,
        revision: s.revision,
        role: s.role,
        title: s.title,
        origin: s.origin,
        updatedAt: s.updated_at,
        complete: !!s.complete,
        excerpt,
        link: s.link,
      });
    } catch {}
    if (sources.length >= 5) break;
  }
  return { mode: "lexical", sources };
}
const routes = registrar("memoryRoutes");
export const memoryRoutes = routes.mount;
routes.on(workspaceApi.conversationMemory, (req, res) => {
  const conversation = ownedConversation(req.params.id, res.locals.owner);
  res.json({
    memoryIncluded: enabled(
      res.locals.owner,
      "conversation:" + conversation.id,
      false,
    ),
  });
});
routes.on(workspaceApi.memoryStatus, (_req, res) => {
  const owner = res.locals.owner;
  res.json({
    policies: memoryPolicyQueries.forOwner(db, owner),
    sources: memorySourcesQueries.summaries(db, owner) as z.input<
      typeof workspaceApi.memoryStatus.response
    >["sources"],
  });
});
routes.on(workspaceApi.memoryPolicy, (req, res) => {
  const { scope, enabled: value } = req.body,
    owner = res.locals.owner;
  const [kind, key] = scope.split(":");
  if (kind === "project") ownedFolder(key, owner);
  else if (kind === "conversation") ownedConversation(key, owner);
  else if (kind === "artifact") ownedArtifact(key, owner);
  else if (scope !== "workspace")
    throw new Problem(400, "Unknown memory scope");
  db.transaction(() => {
    memoryPolicyQueries.set(db, owner, scope, value ? 1 : 0);
    const sources = memorySourcesQueries.forOwner(db, owner);
    for (const s of sources) {
      if (
        scope !== "workspace" &&
        !(kind === "project" && s.project_id === key) &&
        !(kind === "conversation" && s.conversation_id === key) &&
        !(kind === "artifact" && s.source_id === key)
      )
        continue;
      memorySourcesQueries.advanceRevision(db, now(), s.id);
    }
  }).immediate();
  res.json({ ok: true });
});
routes.on(workspaceApi.memorySource, (req, res) => {
  const s = ownedMemorySource(req.params.id, res.locals.owner);
  if (s.kind === "note" && !s.tombstone)
    return res.json({
      ...s,
      kind: s.kind,
      truncated: false,
    } as z.input<typeof workspaceApi.memorySource.response>);
  res.json(
    readMemory(res.locals.owner, req.params.id) as unknown as z.input<
      typeof workspaceApi.memorySource.response
    >,
  );
  return undefined;
});
routes.on(workspaceApi.memorySourceDelete, (req, res) => {
  const s = ownedMemorySource(req.params.id, res.locals.owner);
  db.transaction(() => {
    memorySourcesQueries.tombstone(db, s.id);
  }).immediate();
  res.json({ ok: true, originalHistoryRetained: true });
});
routes.on(workspaceApi.memoryNoteCreate, (req, res) => {
  const d = req.body;
  if (d.projectId) ownedFolder(d.projectId, res.locals.owner);
  const source = id();
  db.transaction(() =>
    putSource({
      owner_id: res.locals.owner,
      source_id: source,
      kind: "note",
      role: "user-note",
      origin: "loop",
      project_id: d.projectId,
      content: d.content,
      title: d.title,
      eligible: true,
      created_at: now(),
    }),
  ).immediate();
  res.json({ id: digest(res.locals.owner + ":note:" + source) });
});
routes.on(workspaceApi.runMemory, (req, res) => {
  ownedRun(req.params.id, res.locals.owner);
  res.json(
    (memoryReceiptsQueries.get(db, req.params.id) || {
      mode: "not-used",
      sources: "[]",
      tokens: 0,
    }) as z.input<typeof workspaceApi.runMemory.response>,
  );
});

routes.on(workspaceApi.memoryNoteUpdate, (req, res) => {
  const s = ownedMemorySource(req.params.id, res.locals.owner);
  const d = req.body;
  if (s.kind !== "note" || s.tombstone || s.revision !== d.revision)
    throw new Problem(409, "Note changed or is unavailable");
  db.transaction(() =>
    putSource({ ...s, ...d, created_at: s.created_at, eligible: !!s.eligible }),
  ).immediate();
  res.json({ ok: true });
});
routes.on(workspaceApi.memoryNoteVersions, (req, res) => {
  const s = ownedMemorySource(req.params.id, res.locals.owner);
  if (s.kind !== "note" || s.tombstone)
    throw new Problem(404, "Note unavailable");
  res.json(memoryNoteVersionsQueries.history(db, s.id));
});
