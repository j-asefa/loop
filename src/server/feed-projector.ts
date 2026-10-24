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
import { displayFeedCard, type FeedCardDetail } from "./feed-card-display.js";

export type StoredCard = {
  row: SourceRow;
  detail: FeedCardDetail;
  legacy?: { row: SourceRow; detail: FeedCardDetail };
  thread?: ThreadDetails;
};
export type CardKind = "thread" | "result" | "idle";
type Emit = (
  owner: string,
  subject: WorkspaceSubject,
  ...event: WorkspaceEmission
) => unknown;
type Dirty = { owner_id: string; conversation_id: string; card_key: string };

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
  const upsert =
    db.prepare(`INSERT INTO feed_cards(owner_id,conversation_id,kind,card_key,folder_id,agent_id,team_id,sort_at,
    needs_run,approval_until,working,queued,snoozed,completed,hidden,hide_results,payload,legacy_sort_at,legacy_hidden)
    VALUES(@owner,@conversation,@kind,@key,@folder,@agent,@team,@sort,@needs,@until,@working,@queued,@snoozed,@completed,@hidden,@hide,@payload,@legacySort,@legacyHidden)
    ON CONFLICT(owner_id,conversation_id,kind,card_key) DO UPDATE SET folder_id=excluded.folder_id,agent_id=excluded.agent_id,team_id=excluded.team_id,
    sort_at=excluded.sort_at,needs_run=excluded.needs_run,approval_until=excluded.approval_until,working=excluded.working,queued=excluded.queued,
    snoozed=excluded.snoozed,completed=excluded.completed,hidden=excluded.hidden,hide_results=excluded.hide_results,payload=excluded.payload,
    legacy_sort_at=excluded.legacy_sort_at,legacy_hidden=excluded.legacy_hidden WHERE feed_cards.payload IS NOT excluded.payload`);
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
      const changed = upsert.run({
        owner,
        conversation,
        kind,
        key,
        folder: r.folder_id,
        agent: r.agent_id,
        team: r.team_id,
        sort: r.sort_at,
        needs: r.needs_run,
        until: r.approval_until,
        working: r.is_working,
        queued: r.has_queued,
        snoozed: r.snoozed,
        completed: r.is_done,
        hidden: r.hidden,
        hide: r.hide_results,
        payload: JSON.stringify(stored),
        legacySort: stored.legacy?.row.sort_at ?? r.sort_at,
        legacyHidden: stored.legacy?.row.hidden ?? r.hidden,
      }).changes;
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
          // Oversized cards retain the scoped reconciliation signal without
          // letting an auxiliary projection event reject a valid source write.
          card:
            Buffer.byteLength(JSON.stringify(display)) <= 60_000
              ? display
              : null,
        });
      }
    }
    const legacy = sourceCards(db, owner, conversation, "legacy")[0];
    save("thread", {
      row,
      detail: detail(row.card_run),
      legacy: { row: legacy, detail: detail(legacy.card_run) },
      thread,
    });
    const idle = sourceCards(db, owner, conversation, "idle")[0];
    save("idle", { row: idle, detail: detail(null) });
    const selected = keys.has("*")
      ? null
      : [...keys].filter(
          (key) => key.startsWith("run:") || key.startsWith("message:"),
        );
    if (selected && !selected.length) continue;
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
}
