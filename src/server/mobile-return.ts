import * as messagesQueries from "./sql/messages.js";
import * as runsQueries from "./sql/runs.js";
import { DoneReadInput, FeedUpdateInput, SavedLabelInput } from "../shared/mobile-contract-schemas.js";
import { assertFeedApplied, projectionFeed, projectionDoneRows } from "./feed-card-read.js";
import { ensureWorkspaceProject } from "./workspace-project.js";
import { z } from "zod";
import { db, now, emit } from "./db.js";
import { doneUnreadVersion, advanceDoneUnreadVersion } from "./done-read-state.js";
import { ownedAgent, ownedFolder, ownedConversation, ownedMessage, owned, Problem } from "./domain.js";
import { resultOutputSql, fileArtifactSql, projectFolders, resultUrl } from "./results.js";
import { unreadCount } from "./news.js";
import { FEED_FILTERS, type FeedPage } from "../shared/workspace-api.js";
import { collapse, encode, decode, FOLDER_PROJECT, projectFor, contains } from "./mobile-return/shared.js";

// Keep the existing route and worker import surface stable.
export { conversationReturnState, savePosition } from "./mobile-return/reading-position.js";
export { conversationOutline } from "./mobile-return/outlines.js";
export { createLater, snoozeLater, reopenLater, listLater, finishLater, projectOpened, enqueuePush, surfaceLater } from "./mobile-return/later.js";
export { createScheduledSend, listScheduledSends, cancelScheduledSend, editScheduledSend, retryScheduledSend, deliverScheduledSends } from "./mobile-return/scheduled-sends.js";
export { reorderRun, editQueuedRun, withdrawQueuedRun, moveQueuedRun } from "./mobile-return/queued-runs.js";
export { forkConversation } from "./mobile-return/forking.js";


// ---------------------------------------------------------------------------
// 2. Inbox
export { FEED_FILTERS } from "../shared/workspace-api.js";
function readFeed(
  owner: string,
  options: {
    filter?: (typeof FEED_FILTERS)[number];
    expand?: "results";
    folder?: string;
    teams?: string[];
    agent?: string;
    before?: string;
  },
): FeedPage {
  if (options.agent) ownedAgent(options.agent, owner);
  const filter = options.filter || "all";
  // Older open tabs key and paginate by conversation. Only clients that
  // understand independent result identities opt into the expanded collection.
  const results = filter === "done" && options.expand === "results";
  const teams = options.teams?.length ? options.teams : undefined;
  let folders: (string | null)[] | undefined;
  if (options.folder) {
    ownedFolder(options.folder, owner);
    folders = projectFolders(owner, options.folder);
  }
  const cursor = options.before
    ? decode(
        options.before,
        z.tuple([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z.string().min(1).max(150),
          // Older cursors contain only a time and conversation. New Done
          // cursors also distinguish results that finished at the same time.
          z.string().min(1).max(200).optional(),
        ]),
        "feed",
      )
    : undefined;
  const mode =
    filter === "done" ? "done" : filter === "working" ? "working" : "thread";
  const params = {
    owner,
    now: now(),
    mode,
    teams: teams ? JSON.stringify(teams) : null,
    folders: folders ? JSON.stringify(folders) : null,
    agent: options.agent ?? null,
    at: cursor?.[0] ?? null,
    after: cursor?.[1] ?? null,
    afterCard: cursor?.[2] ?? null,
  };
  const replyPage = filter === "replies" ? readReplyFeed(params) : undefined;
  const { page, summary } = projectionFeed(db, params, filter, results);
  const more = page.length > 40;
  if (more) page.pop();
  const rows = page.map(item => item.row);
  const laterDue = db
    .prepare(
      "SELECT count(*) n FROM later_items WHERE owner_id=? AND surfaced_at IS NOT NULL AND done_at IS NULL",
    )
    .get(owner) as { n: number };
  // Scheduled messages, owner-wide: not sent (needs you) apart from waiting.
  const scheduled = db
    .prepare(
      "SELECT COALESCE(sum(state='failed'),0) failed,COALESCE(sum(state='scheduled'),0) pending FROM scheduled_sends WHERE owner_id=?",
    )
    .get(owner) as { failed: number; pending: number };
  const last = rows.at(-1);
  return {
    items: replyPage ? replyPage.items : page.map(item => item.display),
    next: replyPage ? replyPage.next :
      more && last
        ? encode(
            results
              ? [last.sort_at, last.conversation_id, last.done_card_key]
              : [last.sort_at, last.conversation_id],
          )
        : null,
    summary: {
      needs: summary.needs,
      working: summary.working,
      queued: summary.queued,
      replies_unread: replyUnread(params),
      done_unread: summary.done_unread,
      later_due: laterDue.n,
      social_unread: unreadCount(owner),
      scheduled_failed: scheduled.failed,
      scheduled_pending: scheduled.pending,
    },
  };
}

type ReplyScope = {
  owner: string; teams: string | null; folders: string | null; agent: string | null;
};
const replyFolder = "CASE WHEN json_type(r.payload,'$.folderId') IS NOT NULL THEN json_extract(r.payload,'$.folderId') ELSE c.project_id END";
const replyScopeSql = `FROM steering_replies p
  JOIN messages m ON m.id=p.message_id AND m.owner_id=p.owner_id
  JOIN run_steering s ON s.id=p.steering_id AND s.owner_id=p.owner_id
  JOIN messages q ON q.id=s.message_id AND q.owner_id=p.owner_id
  JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=p.owner_id
  JOIN runs r ON r.id=m.run_id AND r.owner_id=p.owner_id
  WHERE p.owner_id=@owner AND p.archived_at IS NULL
    AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
    AND (@agent IS NULL OR r.agent_id=@agent)
    AND (@folders IS NULL OR ${replyFolder} IN (SELECT value FROM json_each(@folders))
      OR (${replyFolder} IS NULL AND EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS NULL)))`;

function replyUnread(scope: ReplyScope) {
  return (db.prepare(`SELECT count(*) n ${replyScopeSql} AND p.read_at IS NULL`).get(scope) as { n: number }).n;
}

function readReplyFeed(scope: ReplyScope & { at: number | null; after: string | null; afterCard: string | null }) {
  const rows = db.prepare(`SELECT p.message_id,p.created_at,p.read_at,q.id question_id,substr(q.content,1,1000) question,
    substr(m.content,1,1000) content,c.id conversation_id,c.title,c.origin,c.team_id,r.agent_id,
    ${replyFolder} folder_id,r.id run_id,r.state,r.error,r.input,r.created_at run_created_at,r.updated_at,
    json_extract(r.payload,'$.connectionId') connection_id,json_extract(r.payload,'$.model') model,
    json_extract(r.payload,'$.resolvedModel') resolved_model,json_extract(r.payload,'$.provider') provider,
    COALESCE(json_extract(r.payload,'$.name'),(SELECT name FROM agents WHERE id=r.agent_id AND owner_id=@owner)) agent_name,
    EXISTS(SELECT 1 FROM message_bookmarks b WHERE b.owner_id=@owner AND b.message_id=m.id) saved
    ${replyScopeSql}
      AND (@at IS NULL OR (p.created_at,c.id,'reply:'||p.message_id)<(@at,@after,@afterCard))
    ORDER BY p.created_at DESC,c.id DESC,p.message_id DESC LIMIT 41`).all(scope) as {
      message_id: string; created_at: number; read_at: number | null; question_id: string; question: string; content: string;
      conversation_id: string; title: string; origin: string; team_id: string | null; agent_id: string | null;
      folder_id: string | null; run_id: string; state: string; error: string | null; input: string;
      run_created_at: number; updated_at: number; connection_id: string | null; model: string | null;
      resolved_model: string | null; provider: string | null; agent_name: string | null; saved: number;
    }[];
  const more = rows.length > 40;
  if (more) rows.pop();
  const last = rows.at(-1);
  return {
    items: rows.map(row => {
      const project = projectFor(scope.owner, row.folder_id);
      return {
        conversation_id: row.conversation_id, reply_card_key: `reply:${row.message_id}`,
        reply: { message_id: row.question_id, content: row.question, read_at: row.read_at },
        title: collapse(row.question, 200) || row.title,
        agent_id: row.agent_id, agent_name: row.agent_name, provider: row.provider,
        connection_id: row.connection_id, project_id: project?.id ?? null, project_name: project?.name ?? null,
        team_id: row.team_id, origin: row.origin, last_activity_at: row.created_at,
        last_message: { id: row.message_id, role: "assistant", preview: row.content, created_at: row.created_at, saved: !!row.saved },
        run: { id: row.run_id, state: row.state, error: row.error, input: row.input,
          connection_id: row.connection_id, model: row.model, resolved_model: row.resolved_model,
          created_at: row.run_created_at, updated_at: row.updated_at, queue_position: null },
        pending_approvals: 0, position_message_id: null, later: null, next_action: null,
      };
    }),
    next: more && last ? encode([last.created_at, last.conversation_id, `reply:${last.message_id}`]) : null,
  };
}

/** Read selection and its summary at the same applied-through snapshot. */
export function feed(owner: string, options: Parameters<typeof readFeed>[1]) {
  return db.transaction(() => { assertFeedApplied(db); return readFeed(owner, options); })();
}
export function doneCardRows(owner: string, options: {
  folders: (string | null)[] | null; teamIds: string[]; agent?: string;
  before?: [number, string] | null; ids?: string[]; limit: number; detail?: boolean; atTime?: number;
  includeDismissed?: boolean;
  read?: "read" | "unread";
}) {
  if (options.ids && !options.ids.length) return [];
  return db.transaction(() => {
    assertFeedApplied(db);
    return projectionDoneRows(db, { owner, now: options.atTime ?? now(), read: options.read,
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null, agent: options.agent ?? null,
      ids: options.ids ? JSON.stringify(options.ids) : null, at: options.before?.[0] ?? null,
      key: options.before?.[1] ?? null, limit: options.limit, detail: !!options.detail,
      includeDismissed: !!options.ids && !!options.includeDismissed });
  })();
}

export function setDoneCardHidden(
  owner: string,
  conversation: string,
  body: unknown,
) {
  const { hidden, cardKey } = FeedUpdateInput.parse(body);
  return db
    .transaction(() => {
      ownedConversation(conversation, owner);
      const isRun = cardKey.startsWith("run:");
      const target = cardKey.slice(cardKey.indexOf(":") + 1);
      const record = (isRun ? runsQueries.doneInConversation(db, target, owner, conversation) : messagesQueries.existsInConversation(db, target, owner, conversation));
      if (!record) throw new Problem(404, "Done card not found");
      if (hidden) {
        db.prepare(
          "INSERT OR IGNORE INTO done_card_dismissals(owner_id,conversation_id,card_key,created_at) VALUES(?,?,?,?)",
        ).run(owner, conversation, cardKey, now());
      } else {
        db.prepare(
          "DELETE FROM done_card_dismissals WHERE owner_id=? AND conversation_id=? AND card_key=?",
        ).run(owner, conversation, cardKey);
      }
      return { ok: true };
    })
    .immediate();
}
/** Set a Done result's read state. Repeated reads keep the first read time. */
export function setDoneCardRead(
  owner: string,
  conversation: string,
  body: unknown,
  read: boolean,
) {
  const { cardKey, unreadVersion = 0 } = DoneReadInput.parse(body);
  return db
    .transaction(() => {
      ownedConversation(conversation, owner);
      const card = db
        .prepare(
          "SELECT 1 FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='result' AND card_key=?",
        )
        .get(owner, conversation, cardKey);
      if (!card) throw new Problem(404, "Done card not found");
      if (read) {
        if (unreadVersion !== doneUnreadVersion(owner, conversation, cardKey))
          return { ok: true };
        db.prepare(
          "INSERT OR IGNORE INTO done_card_reads(owner_id,conversation_id,card_key,read_at) VALUES(?,?,?,?)",
        ).run(owner, conversation, cardKey, now());
      } else {
        db.prepare(
          "DELETE FROM done_card_reads WHERE owner_id=? AND conversation_id=? AND card_key=?",
        ).run(owner, conversation, cardKey);
        const version = advanceDoneUnreadVersion(owner, conversation, cardKey);
        emit(owner, { kind: "collection", id: "feed" }, "invalidate", { scope: { kind: "collection", id: "feed" } });
        return { ok: true, unreadVersions: { ["d:" + cardKey]: version } };
      }
      return { ok: true };
    })
    .immediate();
}
type AwayItem = {
  conversation_id: string;
  title: string;
  agent_name: string | null;
  run_id: string;
  state: string;
  updated_at: number;
};
export function awaySummary(owner: string, since: number) {
  return runsQueries.awaySummary(db, owner, since, now);
}

// ---------------------------------------------------------------------------
// 3. Saved
// One list for everything you keep: results and messages alike. A reply that
// has a result card is saved by pinning that result, so saving either one
// saves both and the list shows it once.
function resultFor(owner: string, messageId: string) {
  return db
    .prepare(
      "SELECT a.id,a.pinned FROM artifacts a JOIN messages m ON m.id=? AND m.owner_id=a.owner_id AND m.conversation_id=a.conversation_id WHERE a.owner_id=? AND a.archived=0 AND json_extract(a.metadata,'$.messageId')=m.id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1",
    )
    .get(messageId, owner) as { id: string; pinned: number } | undefined;
}

export function setSaved(owner: string, messageId: string, on: boolean) {
  return db
    .transaction(() => {
      const message = ownedMessage(messageId, owner);
      if (message.metadata.progress)
        throw new Problem(400, "Only saved messages can be kept");
      const result = resultFor(owner, messageId),
        savedAt = now();
      if (result && result.pinned !== Number(on)) {
        db.prepare(
          "UPDATE artifacts SET pinned=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND pinned<>?",
        ).run(Number(on), savedAt, result.id, owner, Number(on));
      }
        on && !result
          ? db
              .prepare(
                "INSERT OR IGNORE INTO message_bookmarks(owner_id,message_id,created_at) VALUES(?,?,?)",
              )
              .run(owner, messageId, savedAt).changes
          : db
              .prepare(
                "DELETE FROM message_bookmarks WHERE owner_id=? AND message_id=?",
              )
              .run(owner, messageId).changes;
      return { ok: true as const, saved: on };
    })
    .immediate();
}

const savedCursor = z.object({ at: z.number(), key: z.string() });
export function listSaved(
  owner: string,
  options: {
    before?: string;
    folder?: string;
    teams?: string[];
    /** Text in a saved item, its thread title or its label. */
    q?: string;
  } = {},
) {
  const cursor = options.before
    ? decode(options.before, savedCursor, "saved")
    : null;
  if (options.folder) ownedFolder(options.folder, owner);
  const page = 30;
  // The same project and team scope as the results feed.
  const params = {
    owner,
    at: cursor?.at ?? null,
    key: cursor?.key ?? null,
    limit: page + 1,
    folders: options.folder
      ? JSON.stringify(projectFolders(owner, options.folder))
      : null,
    teams: options.teams?.length ? JSON.stringify(options.teams) : null,
    q: options.q?.trim() ? contains(options.q.trim()) : null,
  };
  const after = (at: string, key: string) =>
    `(@at IS NULL OR ${at}<@at OR (${at}=@at AND ${key}<@key))`;
  const messages = db
    .prepare(
      `WITH RECURSIVE ${FOLDER_PROJECT}
      SELECT 'm:'||b.message_id key,b.created_at saved_at,b.message_id,m.conversation_id,
        c.title conversation_title,m.role,substr(m.content,1,4000) content,m.created_at,
        a.id agent_id,a.name agent_name,a.provider,project.name project_name,l.label
      FROM message_bookmarks b
      LEFT JOIN saved_labels l ON l.owner_id=b.owner_id AND l.item_key='m:'||b.message_id
      JOIN messages m ON m.id=b.message_id AND m.owner_id=b.owner_id
      JOIN conversations c ON c.id=m.conversation_id AND c.owner_id=b.owner_id
      LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=b.owner_id
      LEFT JOIN agents a ON a.id=COALESCE(r.agent_id,c.agent_id) AND a.owner_id=b.owner_id
      LEFT JOIN folder_project fp ON fp.id IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)
      LEFT JOIN folders project ON project.id=fp.project_id AND project.owner_id=b.owner_id
      WHERE b.owner_id=@owner AND ${after("b.created_at", "'m:'||b.message_id")}
        AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS COALESCE(json_extract(r.payload,'$.folderId'),c.project_id)))
        AND (@teams IS NULL OR c.team_id IN (SELECT value FROM json_each(@teams)))
        AND (@q IS NULL OR m.content LIKE @q ESCAPE '\\' OR c.title LIKE @q ESCAPE '\\' OR l.label LIKE @q ESCAPE '\\')
      ORDER BY b.created_at DESC,key DESC LIMIT @limit`,
    )
    .all(params) as (Record<string, unknown> & {
    key: string;
    saved_at: number;
    content: string;
  })[];
  // The same columns as a saved card in the results feed.
  const results = db
    .prepare(
      `SELECT 'a:'||a.id key,COALESCE(p.saved_at,a.updated_at) saved_at,a.*,r.state run_state,r.error run_error,
        json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,g.name,g.provider,
        (SELECT team_id FROM conversations WHERE id=a.conversation_id) team_id,l.label saved_label
      FROM artifacts a JOIN artifact_bookmarks p ON p.artifact_id=a.id
      LEFT JOIN saved_labels l ON l.owner_id=a.owner_id AND l.item_key='a:'||a.id
      LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
      LEFT JOIN agents g ON g.id=a.agent_id
      WHERE a.owner_id=@owner AND a.archived=0 AND a.pinned=1 AND ${fileArtifactSql}
        AND json_extract(a.metadata,'$.snippet') IS NULL
        AND ${after("COALESCE(p.saved_at,a.updated_at)", "'a:'||a.id")}
        AND (@folders IS NULL OR EXISTS(SELECT 1 FROM json_each(@folders) WHERE value IS a.folder_id))
        AND (@teams IS NULL OR a.conversation_id IN (SELECT id FROM conversations WHERE owner_id=@owner AND team_id IN (SELECT value FROM json_each(@teams))))
        AND (@q IS NULL OR a.title LIKE @q ESCAPE '\\' OR a.content LIKE @q ESCAPE '\\' OR l.label LIKE @q ESCAPE '\\')
      ORDER BY COALESCE(p.saved_at,a.updated_at) DESC,key DESC LIMIT @limit`,
    )
    .all(params) as (Record<string, unknown> & {
    key: string;
    saved_at: number;
  })[];
  const merged = [
    ...messages.map(({ key, saved_at, content, label, ...row }) => ({
      kind: "message" as const,
      key,
      saved_at,
      label: (label as string | null) ?? null,
      message: {
        ...row,
        preview: collapse(content, 280),
        // Markdown for full-size cards; the client clips it visually.
        content,
      },
    })),
    ...results.map(({ key, saved_at, saved_label, ...row }) => ({
      kind: "result" as const,
      key,
      saved_at,
      label: (saved_label as string | null) ?? null,
      result: row,
    })),
  ].sort((a, b) => b.saved_at - a.saved_at || (a.key < b.key ? 1 : -1));
  const more = merged.length > page;
  const items = merged.slice(0, page);
  const last = items.at(-1);
  return {
    items,
    next: more && last ? encode({ at: last.saved_at, key: last.key }) : null,
  };
}

/**
 * Set or clear the short label of a saved item ("Chosen approach"). Only an
 * item the owner currently has saved can be labelled.
 */
export function setSavedLabel(owner: string, body: unknown) {
  const d = SavedLabelInput.parse(body);
  return db
    .transaction(() => {
      const target = d.key.slice(2);
      const saved = d.key.startsWith("m:")
        ? db
            .prepare(
              "SELECT 1 FROM message_bookmarks WHERE owner_id=? AND message_id=?",
            )
            .get(owner, target)
        : db
            .prepare(
              "SELECT 1 FROM artifacts a JOIN artifact_bookmarks p ON p.artifact_id=a.id WHERE a.id=? AND a.owner_id=? AND a.pinned=1 AND a.archived=0",
            )
            .get(target, owner);
      if (!saved) throw new Problem(404, "Saved item not found");
      if (d.label)
        db.prepare(
          `INSERT INTO saved_labels(owner_id,item_key,label,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(owner_id,item_key) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at`,
        ).run(owner, d.key, d.label, now());
      else
        db.prepare(
          "DELETE FROM saved_labels WHERE owner_id=? AND item_key=?",
        ).run(owner, d.key);
      return { key: d.key, label: d.label || null };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// 10. Usage
type Tokens = { input_tokens: number; output_tokens: number };
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
export function conversationUsage(owner: string, conversation: string) {
  ownedConversation(conversation, owner);
  const events = runsQueries.conversationUsageEvents(db, owner, conversation) as {
    run_id: string;
    type: string;
    payload: string;
  }[];
  const runs: Record<string, Tokens> = {};
  const native: Record<string, Tokens> = {};
  // A provider message is one receipt with an externalId, optionally followed
  // by cumulative deltas (Anthropic message_start + message_delta). Take the
  // maximum per message so cumulative counts are not added twice.
  let segment: { run: string; tokens: Tokens } | undefined;
  const flush = () => {
    if (!segment) return;
    const total = (runs[segment.run] ||= { input_tokens: 0, output_tokens: 0 });
    total.input_tokens += segment.tokens.input_tokens;
    total.output_tokens += segment.tokens.output_tokens;
    segment = undefined;
  };
  for (const event of events) {
    let payload: { usage?: Record<string, unknown>; externalId?: unknown };
    try {
      payload = JSON.parse(event.payload);
    } catch {
      continue;
    }
    const usage = payload.usage;
    if (event.type === "native.usage") {
      if (!usage || typeof usage !== "object") continue;
      const total = (native[event.run_id] ||= {
        input_tokens: 0,
        output_tokens: 0,
      });
      total.input_tokens = Math.max(
        total.input_tokens,
        count(usage.input_tokens),
      );
      total.output_tokens = Math.max(
        total.output_tokens,
        count(usage.output_tokens),
      );
      continue;
    }
    if (payload.externalId || !segment || segment.run !== event.run_id) {
      flush();
      segment = {
        run: event.run_id,
        tokens: { input_tokens: 0, output_tokens: 0 },
      };
    }
    if (!usage || typeof usage !== "object") continue;
    const input = count(usage.input_tokens) || count(usage.prompt_tokens);
    const output = count(usage.output_tokens) || count(usage.completion_tokens);
    segment.tokens.input_tokens = Math.max(segment.tokens.input_tokens, input);
    segment.tokens.output_tokens = Math.max(
      segment.tokens.output_tokens,
      output,
    );
  }
  flush();
  Object.assign(runs, native);
  for (const [run, tokens] of Object.entries(runs))
    if (!tokens.input_tokens && !tokens.output_tokens) delete runs[run];
  const total = Object.values(runs).reduce(
    (sum, tokens) => ({
      input_tokens: sum.input_tokens + tokens.input_tokens,
      output_tokens: sum.output_tokens + tokens.output_tokens,
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
  // Only runtimes that recall memory record a receipt, so the thread offers
  // "Memory used" on these runs alone.
  const memory = (
    db
      .prepare(
        `SELECT m.run_id FROM memory_receipts m JOIN runs r ON r.id=m.run_id
        WHERE r.owner_id=? AND r.conversation_id=?`,
      )
      .all(owner, conversation) as { run_id: string }[]
  ).map((row) => row.run_id);
  return { runs, total, memory };
}

// ---------------------------------------------------------------------------
// 11. Snippets
export function listSnippets(owner: string) {
  // Saving the same text twice makes two artifacts; offer it once, newest.
  // Duplicates collapse before the limit, so a run of repeated saves can't
  // push older, different snippets out of the list.
  return {
    items: db
      .prepare(
        `SELECT id,title,content,created_at FROM (
          SELECT id,title,content,created_at,rowid AS row,
            row_number() OVER (
              PARTITION BY trim(content,' '||char(9)||char(10)||char(13))
              ORDER BY created_at DESC,rowid DESC
            ) copy
          FROM artifacts WHERE owner_id=? AND archived=0
            AND (json_extract(metadata,'$.snippet')=1 OR title LIKE 'Saved prompt:%')
        ) WHERE copy=1 ORDER BY created_at DESC,row DESC LIMIT 100`,
      )
      .all(owner),
  };
}

// ---------------------------------------------------------------------------
// 12. Project summaries
export function projectSummaries(owner: string) {
  ensureWorkspaceProject(owner);
  const projects = db
    .prepare(
      "SELECT id,name FROM folders WHERE owner_id=? AND kind='project' AND parent_id IS NULL",
    )
    .all(owner) as { id: string; name: string }[];
  const byProject = <T>(sql: string) =>
    new Map(
      (
        db
          .prepare(`WITH RECURSIVE ${FOLDER_PROJECT} ${sql}`)
          .all({ owner }) as (T & { project_id: string })[]
      ).map((row) => [row.project_id, row]),
    );
  const agents = byProject<{ n: number }>(
    "SELECT fp.project_id,count(*) n FROM agents a JOIN folder_project fp ON fp.id IS a.folder_id WHERE a.owner_id=@owner AND a.retired_at IS NULL GROUP BY fp.project_id",
  );
  const runs = new Map(runsQueries.projectSummaries(db, owner).map(row => [row.project_id, row]));
  const artifacts = byProject<{ last: number }>(
    "SELECT fp.project_id,max(a.updated_at) last FROM artifacts a JOIN folder_project fp ON fp.id IS a.folder_id WHERE a.owner_id=@owner AND a.archived=0 GROUP BY fp.project_id",
  );
  const latest = byProject<{ id: string; title: string; created_at: number }>(
    `SELECT project_id,id,title,created_at FROM (
      SELECT fp.project_id,a.id,a.title,a.created_at,
        row_number() OVER (PARTITION BY fp.project_id ORDER BY p.sequence DESC) n
      FROM artifacts a JOIN artifact_publications p ON p.artifact_id=a.id
      JOIN folder_project fp ON fp.id IS a.folder_id
      LEFT JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id
      WHERE a.owner_id=@owner AND a.archived=0 AND a.feed_hidden=0 AND ${resultOutputSql}
    ) WHERE n=1`,
  );
  const items = projects.map((project) => {
    const run = runs.get(project.id),
      artifact = artifacts.get(project.id),
      result = latest.get(project.id);
    const activity = Math.max(run?.last ?? 0, artifact?.last ?? 0);
    return {
      id: project.id,
      name: project.name,
      agents: agents.get(project.id)?.n ?? 0,
      last_activity_at: activity || null,
      working: run?.working ?? 0,
      needs: run?.needs ?? 0,
      latest_result: result
        ? { id: result.id, title: result.title, created_at: result.created_at }
        : null,
    };
  });
  items.sort(
    (a, b) =>
      (b.last_activity_at ?? -1) - (a.last_activity_at ?? -1) ||
      a.name.localeCompare(b.name),
  );
  return { items };
}
