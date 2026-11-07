import * as steeringRepliesQueries from "./sql/steering-replies.js";
import type { ReplyScope } from "./sql/steering-replies.js";
import * as agentsQueries from "./sql/agents.js";
import * as laterItemsQueries from "./sql/later-items.js";
import * as scheduledSendsQueries from "./sql/scheduled-sends.js";
import * as doneCardDismissalsQueries from "./sql/done-card-dismissals.js";
import * as feedCardsQueries from "./sql/feed-cards.js";
import * as doneCardReadsQueries from "./sql/done-card-reads.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as messageBookmarksQueries from "./sql/message-bookmarks.js";
import * as savedLabelsQueries from "./sql/saved-labels.js";
import * as memoryReceiptsQueries from "./sql/memory-receipts.js";
import * as foldersQueries from "./sql/folders.js";
import * as messagesQueries from "./sql/messages.js";
import * as runsQueries from "./sql/runs.js";
import {
  DoneReadInput,
  FeedUpdateInput,
  SavedLabelInput,
} from "../shared/mobile-contract-schemas.js";
import {
  assertFeedApplied,
  projectionFeed,
  projectionDoneRows,
} from "./feed-card-read.js";
import { ensureWorkspaceProject } from "./workspace-project.js";
import { z } from "zod";
import { db, now, emit } from "./db.js";
import {
  doneUnreadVersion,
  advanceDoneUnreadVersion,
} from "./done-read-state.js";
import {
  ownedAgent,
  ownedFolder,
  ownedConversation,
  ownedMessage,
  Problem,
} from "./domain.js";
import { projectFolders } from "./results.js";
import { unreadCount } from "./news.js";
import { FEED_FILTERS, type FeedPage } from "../shared/workspace-api.js";
import {
  collapse,
  encode,
  decode,
  projectFor,
  contains,
} from "./mobile-return/shared.js";

// Keep the existing route and worker import surface stable.
export {
  conversationReturnState,
  savePosition,
} from "./mobile-return/reading-position.js";
export { conversationOutline } from "./mobile-return/outlines.js";
export {
  createLater,
  snoozeLater,
  reopenLater,
  listLater,
  finishLater,
  projectOpened,
  enqueuePush,
  surfaceLater,
} from "./mobile-return/later.js";
export {
  createScheduledSend,
  listScheduledSends,
  cancelScheduledSend,
  editScheduledSend,
  retryScheduledSend,
  deliverScheduledSends,
} from "./mobile-return/scheduled-sends.js";
export {
  reorderRun,
  editQueuedRun,
  withdrawQueuedRun,
  moveQueuedRun,
} from "./mobile-return/queued-runs.js";
export { forkConversation } from "./mobile-return/forking.js";

// ---------------------------------------------------------------------------
// 2. Feed
export { FEED_FILTERS } from "../shared/workspace-api.js";
function readFeed(
  owner: string,
  options: {
    filter?: (typeof FEED_FILTERS)[number];
    folder?: string;
    teams?: string[];
    agent?: string;
    before?: string;
  },
): FeedPage {
  if (options.agent) ownedAgent(options.agent, owner);
  const filter = options.filter || "all";
  const results = filter === "done";
  const teams = options.teams?.length ? options.teams : undefined;
  let folders: (string | null)[] | undefined;
  if (options.folder) {
    ownedFolder(options.folder, owner);
    folders = projectFolders(owner, options.folder);
  }
  const cursor = options.before
    ? decode<[number, string, string?]>(
        options.before,
        results || filter === "replies"
          ? z.tuple([
              z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              z.string().min(1).max(150),
              z.string().min(1).max(200),
            ])
          : z.tuple([
              z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              z.string().min(1).max(150),
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
  const rows = page.map((item) => item.row);
  const laterDue = laterItemsQueries.dueCount(db, owner) as { n: number };
  // Scheduled messages, owner-wide: not sent (needs you) apart from waiting.
  const scheduled = scheduledSendsQueries.summary(db, owner) as {
    failed: number;
    pending: number;
  };
  const last = rows.at(-1);
  return {
    items: replyPage ? replyPage.items : page.map((item) => item.display),
    next: replyPage
      ? replyPage.next
      : more && last
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

function replyUnread(scope: ReplyScope) {
  return (steeringRepliesQueries.unread(db, scope) as { n: number }).n;
}

function readReplyFeed(
  scope: ReplyScope & {
    at: number | null;
    after: string | null;
    afterCard: string | null;
  },
) {
  const rows = steeringRepliesQueries.page(db, scope) as {
    message_id: string;
    created_at: number;
    read_at: number | null;
    question_id: string;
    question: string;
    content: string;
    conversation_id: string;
    title: string;
    origin: string;
    team_id: string | null;
    agent_id: string | null;
    folder_id: string | null;
    run_id: string;
    state: string;
    error: string | null;
    input: string;
    run_created_at: number;
    updated_at: number;
    connection_id: string | null;
    model: string | null;
    resolved_model: string | null;
    provider: string | null;
    agent_name: string | null;
    saved: number;
  }[];
  const more = rows.length > 40;
  if (more) rows.pop();
  const last = rows.at(-1);
  return {
    items: rows.map((row) => {
      const project = projectFor(scope.owner, row.folder_id);
      return {
        conversation_id: row.conversation_id,
        reply_card_key: `reply:${row.message_id}`,
        reply: {
          message_id: row.question_id,
          content: row.question,
          read_at: row.read_at,
        },
        title: collapse(row.question, 200) || row.title,
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        provider: row.provider,
        connection_id: row.connection_id,
        project_id: project?.id ?? null,
        project_name: project?.name ?? null,
        team_id: row.team_id,
        origin: row.origin,
        last_activity_at: row.created_at,
        last_message: {
          id: row.message_id,
          role: "assistant",
          preview: row.content,
          created_at: row.created_at,
          saved: !!row.saved,
        },
        run: {
          id: row.run_id,
          state: row.state,
          error: row.error,
          input: row.input,
          connection_id: row.connection_id,
          model: row.model,
          resolved_model: row.resolved_model,
          created_at: row.run_created_at,
          updated_at: row.updated_at,
          queue_position: null,
        },
        pending_approvals: 0,
        position_message_id: null,
        later: null,
        next_action: null,
      };
    }),
    next:
      more && last
        ? encode([
            last.created_at,
            last.conversation_id,
            `reply:${last.message_id}`,
          ])
        : null,
  };
}

/** Read selection and its summary at the same applied-through snapshot. */
export function feed(owner: string, options: Parameters<typeof readFeed>[1]) {
  return db.transaction(() => {
    assertFeedApplied(db);
    return readFeed(owner, options);
  })();
}
export function doneCardRows(
  owner: string,
  options: {
    folders: (string | null)[] | null;
    teamIds: string[];
    agent?: string;
    before?: [number, string] | null;
    ids?: string[];
    limit: number;
    detail?: boolean;
    atTime?: number;
    includeDismissed?: boolean;
    read?: "read" | "unread";
  },
) {
  if (options.ids && !options.ids.length) return [];
  return db.transaction(() => {
    assertFeedApplied(db);
    return projectionDoneRows(db, {
      owner,
      now: options.atTime ?? now(),
      read: options.read,
      teams: options.teamIds.length ? JSON.stringify(options.teamIds) : null,
      folders: options.folders ? JSON.stringify(options.folders) : null,
      agent: options.agent ?? null,
      ids: options.ids ? JSON.stringify(options.ids) : null,
      at: options.before?.[0] ?? null,
      key: options.before?.[1] ?? null,
      limit: options.limit,
      detail: !!options.detail,
      includeDismissed: !!options.ids && !!options.includeDismissed,
    });
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
      const record = isRun
        ? runsQueries.doneInConversation(db, target, owner, conversation)
        : messagesQueries.existsInConversation(db, target, owner, conversation);
      if (!record) throw new Problem(404, "Done card not found");
      if (hidden) {
        doneCardDismissalsQueries.insert(
          db,
          owner,
          conversation,
          cardKey,
          now(),
        );
      } else {
        doneCardDismissalsQueries.remove(db, owner, conversation, cardKey);
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
      const card = feedCardsQueries.hasResult(db, owner, conversation, cardKey);
      if (!card) throw new Problem(404, "Done card not found");
      if (read) {
        if (unreadVersion !== doneUnreadVersion(owner, conversation, cardKey))
          return { ok: true };
        doneCardReadsQueries.insert(db, owner, conversation, cardKey, now());
      } else {
        doneCardReadsQueries.remove(db, owner, conversation, cardKey);
        const version = advanceDoneUnreadVersion(owner, conversation, cardKey);
        emit(owner, { kind: "collection", id: "feed" }, "invalidate", {
          scope: { kind: "collection", id: "feed" },
        });
        return { ok: true, unreadVersions: { ["d:" + cardKey]: version } };
      }
      return { ok: true };
    })
    .immediate();
}
export function awaySummary(owner: string, since: number) {
  return runsQueries.awaySummary(db, owner, since, now);
}

// ---------------------------------------------------------------------------
// 3. Saved
// One list for everything you keep: results and messages alike. A reply that
// has a result card is saved by pinning that result, so saving either one
// saves both and the list shows it once.
function resultFor(owner: string, messageId: string) {
  return artifactsQueries.messageResult(db, messageId, owner) as
    { id: string; pinned: number } | undefined;
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
        artifactsQueries.bookmark(
          db,
          Number(on),
          savedAt,
          result.id,
          owner,
          Number(on),
        );
      }
      on && !result
        ? messageBookmarksQueries.insert(db, owner, messageId, savedAt).changes
        : messageBookmarksQueries.remove(db, owner, messageId).changes;
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
  const messages = messageBookmarksQueries.page(db, params) as (Record<
    string,
    unknown
  > & {
    key: string;
    saved_at: number;
    content: string;
  })[];
  // The same columns as a saved card in the results feed.
  const results = artifactsQueries.savedPage(db, params) as (Record<
    string,
    unknown
  > & {
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
        ? messageBookmarksQueries.exists(db, owner, target)
        : artifactsQueries.isBookmarked(db, target, owner);
      if (!saved) throw new Problem(404, "Saved item not found");
      if (d.label) savedLabelsQueries.save(db, owner, d.key, d.label, now());
      else savedLabelsQueries.remove(db, owner, d.key);
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
  const events = runsQueries.conversationUsageEvents(
    db,
    owner,
    conversation,
  ) as {
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
    memoryReceiptsQueries.conversationRuns(db, owner, conversation) as {
      run_id: string;
    }[]
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
    items: artifactsQueries.snippets(db, owner),
  };
}

// ---------------------------------------------------------------------------
// 12. Project summaries
export function projectSummaries(owner: string) {
  ensureWorkspaceProject(owner);
  const projects = foldersQueries.rootProjects(db, owner) as {
    id: string;
    name: string;
  }[];
  const byProject = <T extends { project_id: string }>(rows: T[]) =>
    new Map(rows.map((row) => [row.project_id, row]));
  const agents = byProject(agentsQueries.projectCounts(db, owner));
  const runs = new Map(
    runsQueries.projectSummaries(db, owner).map((row) => [row.project_id, row]),
  );
  const artifacts = byProject(artifactsQueries.projectActivity(db, owner));
  const latest = byProject(artifactsQueries.latestProjectResults(db, owner));
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
