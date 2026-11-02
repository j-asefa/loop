import * as messagesQueries from "../sql/messages.js";
import { LaterInput as laterInput } from "../../shared/mobile-contract-schemas.js";
import { db, id, now } from "../db.js";
import { ownedFolder, owned, Problem } from "../domain.js";
import { resultUrl } from "../results.js";
import { savedStory } from "../news.js";
import { feedCardTitle } from "../feed-card-display.js";
import { collapse, projectFor } from "./shared.js";

// A conversation's folder: its recorded project, else its latest run's folder.
const conversationFolder = (c: string) =>
  `COALESCE(${c}.project_id,(SELECT json_extract(fr.payload,'$.folderId') FROM runs fr WHERE fr.owner_id=${c}.owner_id AND fr.conversation_id=${c}.id ORDER BY fr.created_at DESC,fr.rowid DESC LIMIT 1))`;
const ACTIVE_STATES =
  "('queued','running','pausing','paused','awaiting_approval')";

// ---------------------------------------------------------------------------
// 5. Later
type LaterItem = {
  id: string;
  owner_id: string;
  kind: "conversation" | "artifact" | "message" | "story";
  target_id: string;
  condition: "time" | "run_finished" | "project_open";
  due_at: number | null;
  project_id: string | null;
  created_at: number;
  surfaced_at: number | null;
  done_at: number | null;
  snoozes: number;
};
const YEAR = 366 * 24 * 60 * 60 * 1000;

function laterTarget(owner: string, kind: LaterItem["kind"], target: string) {
  if (kind === "story") {
    const story = savedStory(owner, target);
    if (!story) return null;
    return {
      title: story.title,
      preview: story.summary || story.url,
      content: story.summary || "",
      conversation_id: null,
      message_id: null,
      agent_name: null,
      provider: null,
      folder_id: null,
      url: story.url,
    };
  }
  if (kind === "conversation") {
    const c = db
      .prepare(
        `SELECT c.id,c.title,${conversationFolder("c")} folder_id,a.name agent_name,a.provider FROM conversations c LEFT JOIN agents a ON a.id=c.agent_id AND a.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?`,
      )
      .get(target, owner) as
      | {
          id: string;
          title: string;
          folder_id: string | null;
          agent_name: string | null;
          provider: string | null;
        }
      | undefined;
    if (!c) return null;
    const last = messagesQueries.latestContent(db, owner, c.id) as
      { content: string } | undefined;
    return {
      title: c.title as string,
      preview: collapse(last?.content, 200),
      content: last?.content ?? "",
      conversation_id: c.id as string,
      message_id: null,
      agent_name: c.agent_name as string | null,
      provider: c.provider as string | null,
      folder_id: c.folder_id as string | null,
      url: "/?conversation=" + encodeURIComponent(c.id),
    };
  }
  if (kind === "message") {
    const m = messagesQueries.laterTarget(db, target, owner) as
      | ({
          id: string;
          title: string;
          card_run_input: string | null;
          card_run_state: string | null;
          reply_prompt: string | null;
          folder_id: string | null;
          agent_name: string | null;
          provider: string | null;
        } & { content: string; conversation_id: string })
      | undefined;
    if (!m) return null;
    return {
      title: feedCardTitle({
        ...m,
        card_title: collapse(m.reply_prompt, 200) || undefined,
      }),
      preview: collapse(m.content, 200),
      content: m.content as string,
      conversation_id: m.conversation_id as string,
      message_id: m.id as string,
      agent_name: m.agent_name as string | null,
      provider: m.provider as string | null,
      folder_id: m.folder_id as string | null,
      url:
        "/?conversation=" +
        encodeURIComponent(m.conversation_id) +
        "&message=" +
        encodeURIComponent(m.id),
    };
  }
  const a = db
    .prepare(
      "SELECT a.id,a.title,substr(a.content,1,4000) content,a.conversation_id,json_extract(a.metadata,'$.messageId') message_id,a.folder_id,g.name agent_name,g.provider FROM artifacts a LEFT JOIN agents g ON g.id=a.agent_id AND g.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=?",
    )
    .get(target, owner) as
    | ({
        id: string;
        title: string;
        folder_id: string | null;
        agent_name: string | null;
        provider: string | null;
      } & {
        content: string;
        conversation_id: string | null;
        message_id: string | null;
      })
    | undefined;
  if (!a) return null;
  return {
    title: a.title as string,
    preview: collapse(a.content, 200),
    content: a.content as string,
    conversation_id: a.conversation_id as string | null,
    message_id: (a.message_id as string | null) ?? null,
    agent_name: a.agent_name as string | null,
    provider: a.provider as string | null,
    folder_id: a.folder_id as string | null,
    url: resultUrl(a),
  };
}

function validTrigger(
  d: {
    kind?: LaterItem["kind"];
    condition: LaterItem["condition"];
    dueAt?: number;
    projectId?: string;
  },
  time: number,
) {
  // A story has no run and belongs to no project: it comes back at a time.
  if (d.kind === "story" && d.condition !== "time")
    throw new Problem(400, "Choose when to bring this story back");
  if (d.condition === "time") {
    if (d.dueAt === undefined)
      throw new Problem(400, "Choose when to bring this back");
    if (d.dueAt <= time || d.dueAt > time + YEAR)
      throw new Problem(400, "Choose a time within the next year");
  }
  if (d.condition === "project_open" && !d.projectId)
    throw new Problem(400, "Choose a project");
}

/**
 * Remind me about a thread, result or message. An open reminder for the same
 * item is replaced; its id is returned as `replaced` so Undo can reopen it.
 */
export function createLater(owner: string, body: unknown) {
  const d = laterInput.parse(body);
  const time = now();
  validTrigger(d, time);
  return db
    .transaction(() => {
      if (d.kind === "story") {
        // A story is not an owned row: it is public feed content, saved only
        // if this owner follows the feed it came from.
        if (!savedStory(owner, d.targetId))
          throw new Problem(404, "Item not found");
      } else
        owned(
          {
            conversation: "conversations",
            artifact: "artifacts",
            message: "messages",
          }[d.kind],
          d.targetId,
          owner,
        );
      if (d.projectId) ownedFolder(d.projectId, owner);
      const replaced = db
        .prepare(
          "SELECT id FROM later_items WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
        )
        .get(owner, d.kind, d.targetId) as { id: string } | undefined;
      db.prepare(
        "UPDATE later_items SET done_at=? WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
      ).run(time, owner, d.kind, d.targetId);
      const itemId = id();
      db.prepare(
        "INSERT INTO later_items(id,owner_id,kind,target_id,condition,due_at,project_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        itemId,
        owner,
        d.kind,
        d.targetId,
        d.condition,
        d.condition === "time" ? d.dueAt : null,
        d.condition === "project_open" ? d.projectId : null,
        time,
      );
      return { ...laterRow(owner, itemId)!, replaced: replaced?.id ?? null };
    })
    .immediate();
}

/**
 * Snooze a reminder again: the same item gets a new trigger in place, so its
 * target and history stay, and it leaves "Back now" until the new trigger.
 */
export function snoozeLater(owner: string, itemId: string, body: unknown) {
  const d = laterInput
    .pick({ condition: true, dueAt: true, projectId: true })
    .parse(body);
  const time = now();
  validTrigger(d, time);
  return db
    .transaction(() => {
      const item = laterRow(owner, itemId);
      if (!item) throw new Problem(404, "Item not found");
      if (item.done_at !== null)
        throw new Problem(409, "This reminder is already done");
      if (d.projectId) ownedFolder(d.projectId, owner);
      db.prepare(
        "UPDATE later_items SET condition=?,due_at=?,project_id=?,surfaced_at=NULL,snoozes=snoozes+1 WHERE id=? AND owner_id=? AND done_at IS NULL",
      ).run(
        d.condition,
        d.condition === "time" ? d.dueAt : null,
        d.condition === "project_open" ? d.projectId : null,
        itemId,
        owner,
      );
      return laterRow(owner, itemId)!;
    })
    .immediate();
}

/**
 * Undo "Done" or a replacement: reopen a reminder, unless the item already
 * has another open reminder (that newer one wins).
 */
export function reopenLater(owner: string, itemId: string) {
  return db
    .transaction(() => {
      const item = laterRow(owner, itemId);
      if (!item) throw new Problem(404, "Item not found");
      if (item.done_at === null) return item;
      const open = db
        .prepare(
          "SELECT 1 FROM later_items WHERE owner_id=? AND kind=? AND target_id=? AND done_at IS NULL",
        )
        .get(owner, item.kind, item.target_id);
      if (open)
        throw new Problem(409, "This item already has another reminder");
      db.prepare(
        "UPDATE later_items SET done_at=NULL WHERE id=? AND owner_id=?",
      ).run(itemId, owner);
      return laterRow(owner, itemId)!;
    })
    .immediate();
}
const laterRow = (owner: string, itemId: string) =>
  db
    .prepare("SELECT * FROM later_items WHERE id=? AND owner_id=?")
    .get(itemId, owner) as LaterItem | undefined;

export function listLater(owner: string) {
  const rows = db
    .prepare(
      "SELECT * FROM later_items WHERE owner_id=? AND done_at IS NULL ORDER BY COALESCE(surfaced_at,due_at,created_at),created_at LIMIT 400",
    )
    .all(owner) as LaterItem[];
  const view = (item: LaterItem) => {
    const target = laterTarget(owner, item.kind, item.target_id);
    const project =
      projectFor(owner, item.project_id) ||
      projectFor(owner, target?.folder_id);
    return {
      ...item,
      title: target?.title ?? "Item unavailable",
      preview: target?.preview ?? "",
      content: target?.content ?? "",
      provider: target?.provider ?? null,
      conversation_id: target?.conversation_id ?? null,
      message_id: target?.message_id ?? null,
      agent_name: target?.agent_name ?? null,
      project_name: project?.name ?? null,
      // A saved story lives outside Loop55, so Later needs its address to open
      // it; everything else is opened by its conversation or result.
      url: item.kind === "story" ? (target?.url ?? null) : null,
    };
  };
  return {
    due: rows
      .filter((row) => row.surfaced_at !== null)
      .sort((a, b) => b.surfaced_at! - a.surfaced_at!)
      .map(view),
    upcoming: rows.filter((row) => row.surfaced_at === null).map(view),
  };
}

export function finishLater(owner: string, itemId: string) {
  const changed = db
    .prepare(
      "UPDATE later_items SET done_at=? WHERE id=? AND owner_id=? AND done_at IS NULL",
    )
    .run(now(), itemId, owner).changes;
  if (!changed && !laterRow(owner, itemId))
    throw new Problem(404, "Item not found");
  return { ok: true };
}

export function projectOpened(owner: string, project: string) {
  ownedFolder(project, owner);
  return {
    surfaced: db
      .prepare(
        "UPDATE later_items SET surfaced_at=? WHERE owner_id=? AND condition='project_open' AND project_id=? AND surfaced_at IS NULL AND done_at IS NULL",
      )
      .run(now(), owner, project).changes,
  };
}

// Push to every device of the owner. The key doubles as the notification tag.
export function enqueuePush(
  owner: string,
  key: string,
  message: { title: string; body: string; url: string },
  category: "reminders" | "social" = "reminders",
) {
  db.prepare(
    "INSERT OR IGNORE INTO push_messages(subscription_id,message_key,title,body,url,available_at,category) SELECT id,?,?,?,?,?,? FROM push_subscriptions WHERE owner_id=?",
  ).run(
    key,
    message.title.slice(0, 120),
    message.body.slice(0, 140),
    message.url,
    now(),
    category,
    owner,
  );
}

// Worker job. Surfacing and its push commit together, exactly once per item.
export function surfaceLater(time = now()) {
  return db
    .transaction(() => {
      const due = db
        .prepare(
          `SELECT l.* FROM later_items l WHERE l.done_at IS NULL AND l.surfaced_at IS NULL AND (
          (l.condition='time' AND l.due_at<=@now) OR
          (l.condition='run_finished' AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.owner_id=l.owner_id AND r.state IN ${ACTIVE_STATES}
            AND r.conversation_id=(CASE l.kind
              WHEN 'conversation' THEN l.target_id
              WHEN 'message' THEN (SELECT m.conversation_id FROM messages m WHERE m.id=l.target_id AND m.owner_id=l.owner_id)
              ELSE (SELECT COALESCE(a.conversation_id,(SELECT ar.conversation_id FROM runs ar WHERE ar.id=a.run_id)) FROM artifacts a WHERE a.id=l.target_id AND a.owner_id=l.owner_id) END))))
          ORDER BY l.created_at LIMIT 100`,
        )
        .all({ now: time }) as LaterItem[];
      let surfaced = 0;
      for (const item of due) {
        const changed = db
          .prepare(
            "UPDATE later_items SET surfaced_at=? WHERE id=? AND surfaced_at IS NULL AND done_at IS NULL",
          )
          .run(time, item.id).changes;
        if (!changed) continue;
        surfaced++;
        const target = laterTarget(item.owner_id, item.kind, item.target_id);
        enqueuePush(item.owner_id, "later-" + item.id, {
          title: "Back from Later",
          body: target?.title || "An item you deferred is ready",
          url:
            item.kind === "story"
              ? "/?social=" + encodeURIComponent(item.target_id)
              : target?.url || "/?page=profile",
        });
      }
      return surfaced;
    })
    .immediate();
}
