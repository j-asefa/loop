import type Database from "better-sqlite3";
import type {
  WorkspaceEmission,
  WorkspaceSubject,
} from "../shared/workspace-events.js";
import { sourceCards, type SourceRow } from "./feed-card-source.js";
import {
  currentPull,
  runDetails,
  threadDetails,
  type ThreadDetails,
} from "./feed-card-details.js";
import {
  displayFeedCard,
  feedCardTitle,
  feedMessagePrefix,
  type FeedCardDetail,
} from "./feed-card-display.js";

export type StoredCard = {
  row: SourceRow;
  detail: FeedCardDetail;
  thread?: ThreadDetails;
};
export type CardKind = "thread" | "result" | "idle";
type Emit = (
  owner: string,
  subject: WorkspaceSubject,
  ...event: WorkspaceEmission
) => unknown;
type Dirty = { owner_id: string; conversation_id: string; card_key: string };

function threadDisplayRow(row: SourceRow): SourceRow {
  // Feed exposes bounded text. Do not rewrite full streamed answers, prompts
  // or unused message metadata in the thread row on every chunk. Derive the
  // title before truncating input: leading whitespace can hide it past 1000.
  // Result and idle rows retain complete content for the Cards detail reader.
  return {
    ...row,
    card_title:
      (row.card_run_input?.length ?? 0) > 1000 ? feedCardTitle(row) : undefined,
    card_run_input: row.card_run_input?.slice(0, 1000) ?? null,
    message_content:
      row.message_content === null
        ? null
        : feedMessagePrefix(row.message_content),
    message_metadata: null,
  };
}

/** Called inside the producer's outer transaction, including migration backfill.
 * A thread update does not visit its historical result rows. Result identities
 * are selected by the write's dirty keys; metadata fanout explicitly uses '*'.
 */
export function projectFeed(db: Database.Database, emit: Emit) {
  if (!db.inTransaction)
    throw new Error("Feed projection requires the writer transaction");
  const dirty = db
    .prepare(
      "SELECT * FROM feed_card_dirty ORDER BY owner_id,conversation_id,card_key",
    )
    .all() as Dirty[];
  if (!dirty.length) return;
  db.prepare("DELETE FROM feed_card_dirty").run();
  const groups = new Map<
    string,
    { owner: string; conversation: string; keys: Set<string> }
  >();
  for (const row of dirty) {
    const id = JSON.stringify([row.owner_id, row.conversation_id]);
    let group = groups.get(id);
    if (!group)
      groups.set(
        id,
        (group = {
          owner: row.owner_id,
          conversation: row.conversation_id,
          keys: new Set(),
        }),
      );
    group.keys.add(row.card_key);
  }
  const insert =
    db.prepare(`INSERT INTO feed_cards(owner_id,conversation_id,kind,card_key,folder_id,agent_id,team_id,sort_at,
    needs_run,approval_until,working,queued,snoozed,completed,hidden,hide_results,payload,unread)
    VALUES(@owner,@conversation,@kind,@key,@folder_id,@agent_id,@team_id,@sort_at,@needs_run,@approval_until,@working,@queued,@snoozed,@completed,@hidden,@hide_results,@payload,@unread)
`);
  for (const { owner, conversation, keys } of groups.values()) {
    const subject = { kind: "collection" as const, id: "feed" };
    const remove = (kind: CardKind, key: string) => {
      db.prepare(
        "DELETE FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind=? AND card_key=?",
      ).run(owner, conversation, kind, key);
      emit(owner, subject, "feed.card", {
        conversationId: conversation,
        cardKey: key,
        kind,
        removed: true,
        card: null,
      });
    };
    const row = sourceCards(db, owner, conversation, "thread")[0];
    if (!row) {
      for (const old of db
        .prepare(
          "SELECT kind,card_key FROM feed_cards WHERE owner_id=? AND conversation_id=?",
        )
        .all(owner, conversation) as { kind: CardKind; card_key: string }[])
        remove(old.kind, old.card_key);
      continue;
    }
    const thread = threadDetails(db, owner, conversation);
    const details = new Map<string | null, FeedCardDetail>();
    const detail = (run: string | null) => {
      if (!details.has(run)) details.set(run, runDetails(db, owner, run));
      return details.get(run)!;
    };
    function save(kind: CardKind, stored: StoredCard) {
      const r = stored.row,
        key = r.done_card_key ?? "";
      if (kind !== "result") {
        for (const old of db
          .prepare(
            "SELECT card_key FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind=? AND card_key<>?",
          )
          .all(owner, conversation, kind, key) as { card_key: string }[])
          remove(kind, old.card_key);
      }
      const values = {
        folder_id: r.folder_id,
        agent_id: r.agent_id,
        team_id: r.team_id,
        sort_at: r.sort_at,
        needs_run: r.needs_run,
        approval_until: r.approval_until,
        working: r.is_working,
        queued: r.has_queued,
        snoozed: r.snoozed,
        completed: r.is_done,
        hidden: r.hidden,
        hide_results: r.hide_results,
        payload: JSON.stringify(stored),

        // Only a result is read; its read time stays in done_card_reads.
        unread:
          kind === "result" &&
          !db
            .prepare(
              "SELECT 1 FROM done_card_reads WHERE owner_id=? AND conversation_id=? AND card_key=?",
            )
            .get(owner, conversation, key)
            ? 1
            : 0,
      };
      // Only these compile-time column names enter SQL. Updating unchanged
      // indexed columns would still rewrite their B-tree pages in SQLite.
      const columns = Object.keys(values) as (keyof typeof values)[];
      const identity = { owner, conversation, kind, key };
      const previous = db
        .prepare(
          `SELECT ${columns.join(",")} FROM feed_cards
        WHERE owner_id=@owner AND conversation_id=@conversation AND kind=@kind AND card_key=@key`,
        )
        .get(identity) as typeof values | undefined;
      const changedColumns = previous
        ? columns.filter((column) => previous[column] !== values[column])
        : columns;
      if (!changedColumns.length) return;
      const changed = previous
        ? db
            .prepare(
              `UPDATE feed_cards SET ${changedColumns.map((column) => `${column}=@${column}`).join(",")}
          WHERE owner_id=@owner AND conversation_id=@conversation AND kind=@kind AND card_key=@key`,
            )
            .run({ ...identity, ...values }).changes
        : insert.run({ ...identity, ...values }).changes;
      if (changed) {
        // Snapshot clients invalidate the collection; the bounded card also
        // supplies the event's display without shipping full stored answers.
        const approvals = thread.approvals.filter(
          (a) => a.expires_at > Date.now(),
        );
        const display = displayFeedCard(
          {
            ...stored.detail,
            pull: currentPull(thread.watches, Date.now()),
            queued_runs: thread.queued_runs,
          },
          {
            ...r,
            message_content: r.message_content?.slice(0, 4000) ?? null,
            pending_approvals: approvals.length,
            approval_id: approvals[0]?.id ?? null,
            approval_run_id: approvals[0]?.run_id ?? null,
            approval_message_id: approvals[0]?.message_id ?? null,
          },
          kind === "thread" ? "thread" : "done",
        );
        emit(owner, subject, "feed.card", {
          conversationId: conversation,
          cardKey: key,
          kind,
          removed: false,
          // Keep streamed thread events small enough for a typical SQLite
          // page. Larger displays retain the scoped reconciliation signal;
          // the HTTP page delta supplies the complete current display.
          card:
            Buffer.byteLength(JSON.stringify(display)) <=
            (kind === "thread" ? 3_000 : 60_000)
              ? display
              : null,
        });
      }
    }
    save("thread", {
      row: threadDisplayRow(row),
      detail: detail(row.card_run),
      thread,
    });
    const selected = keys.has("*")
      ? null
      : [...keys].filter(
          (key) => key.startsWith("run:") || key.startsWith("message:"),
        );
    if (!selected || selected.length) {
      const results = sourceCards(db, owner, conversation, "result", selected);
      const present = new Set(results.map((r) => r.done_card_key));
      const old = db
        .prepare(
          `SELECT card_key FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='result'
        AND (? IS NULL OR card_key IN (SELECT value FROM json_each(?)))`,
        )
        .all(
          owner,
          conversation,
          selected && JSON.stringify(selected),
          selected && JSON.stringify(selected),
        ) as { card_key: string }[];
      for (const r of old)
        if (!present.has(r.card_key)) remove("result", r.card_key);
      for (const r of results)
        save("result", { row: r, detail: detail(r.card_run) });
    }
    // Active/queued/snoozed/needs-run membership can change only on a write;
    // those threads have no observable idle fallback. Approval timestamps are
    // deliberately excluded: their expiry must reveal an idle without a write.
    // The same applies while historical results replace the idle fallback.
    if (
      row.needs_run ||
      row.is_working ||
      row.has_queued ||
      row.snoozed ||
      db
        .prepare(
          "SELECT 1 FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='result' LIMIT 1",
        )
        .get(owner, conversation)
    ) {
      for (const old of db
        .prepare(
          "SELECT card_key FROM feed_cards WHERE owner_id=? AND conversation_id=? AND kind='idle'",
        )
        .all(owner, conversation) as { card_key: string }[])
        remove("idle", old.card_key);
    } else {
      const idle = sourceCards(db, owner, conversation, "idle")[0];
      save("idle", { row: idle, detail: detail(null) });
    }
  }
}
