import { encodeCursor, decodeCursor } from "./cursors.js";
import * as doneCardReadsQueries from "./sql/done-card-reads.js";
import * as doneThreadsQueries from "./sql/done-threads.js";
import * as doneThreadMembersQueries from "./sql/done-thread-members.js";
import * as doneThreadCreationsQueries from "./sql/done-thread-creations.js";
import { db, now, emit } from "./db.js";
import { ownedAgent, ownedFolder, Problem } from "./domain.js";
import { doneCards } from "./done-cards.js";
import {
  advanceDoneUnreadVersion,
  doneUnreadVersion,
} from "./done-read-state.js";
import { projectFolders } from "./results.js";
import { teamFilter } from "./teams.js";
import { assertFleetAction } from "./fleet-action-context.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MAX_DONE_THREAD_MEMBERS,
  DONE_THREAD_PAGE_BYTES,
  DONE_THREAD_PAGE_ITEMS,
} from "../shared/done-threads.js";
import type { DoneThread, DoneThreadQuery } from "../shared/done-threads.js";

type ThreadRow = NonNullable<ReturnType<typeof doneThreadsQueries.owned>>;
function owned(owner: string, id: string): ThreadRow {
  const row = doneThreadsQueries.owned(db, owner, id);
  if (!row) throw new Problem(404, "Thread not found");
  return row;
}
function cardIds(owner: string, id: string) {
  return doneThreadMembersQueries
    .cards(db, owner, id)
    .map((row) => row.card_id);
}
function cards(
  owner: string,
  ids: string[],
  detail = true,
  selection: Pick<
    Parameters<typeof doneCards>[1],
    "folders" | "teamIds" | "agent"
  > = {
    folders: null,
    teamIds: [],
  },
) {
  return doneCards(owner, {
    ...selection,
    ids,
    limit: ids.length,
    detail,
    // Saved membership uses explicit result identities. Dismissals only control
    // individual Done cards, so a dismissed member stays in its saved thread.
    includeDismissed: true,
  }).flatMap((entry) =>
    entry.card.type === "done" &&
    entry.card.source.message_id &&
    entry.card.display.last_message?.role === "assistant" &&
    entry.card.content.trim()
      ? [entry.card]
      : [],
  );
}
function describe(row: ThreadRow, ids: string[]): DoneThread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    cardIds: ids,
  };
}
function selection(owner: string, query: DoneThreadQuery) {
  if (query.agent) ownedAgent(query.agent, owner);
  if (query.project) ownedFolder(query.project, owner);
  return {
    folders: query.project ? projectFolders(owner, query.project) : null,
    teamIds: teamFilter(query.teams, owner),
    agent: query.agent,
  };
}
function summary(
  owner: string,
  row: ThreadRow,
  selected: ReturnType<typeof selection>,
): DoneThreadSummary | null {
  const visible = cards(owner, cardIds(owner, row.id));
  if (!visible.length) return null;
  // Keep all destinations available, even when only another thread matches
  // the feed filter. The preview alone follows that filter.
  const preview =
    cards(
      owner,
      visible.map((card) => card.id),
      false,
      selected,
    )[0] ?? null;
  return {
    ...describe(
      row,
      visible.map((card) => card.id),
    ),
    preview,
    unread: visible.filter((card) => card.display.read_at === null).length,
    unreadVersions: Object.fromEntries(
      visible.map((card) => [card.id, card.display.unread_version ?? 0]),
    ),
  };
}
export function listDoneThreads(
  owner: string,
  query: DoneThreadQuery = {},
): DoneThreadSummary[] {
  return db.transaction(() => {
    const selected = selection(owner, query);
    return doneThreadsQueries.forOwner(db, owner).flatMap((row) => {
      const value = summary(owner, row, selected);
      return value ? [value] : [];
    });
  })();
}

const ListCursor = z.strictObject({
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.number().int().nonnegative(),
  id: z.string().min(1).max(200),
});
const DetailCursor = z.strictObject({
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  after: z.string().min(1).max(160),
});
const binding = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function tooLarge() {
  return new Problem(
    413,
    "This result exceeds the page limit. Open its original conversation.",
  );
}

/** Cursor and every database lookup stay bound to the requesting local owner. */
export function listDoneThreadPage(
  owner: string,
  query: DoneThreadQuery & { cursor?: string } = {},
): DoneThreadListPage {
  return db.transaction(() => {
    const selected = selection(owner, query);
    const scope = binding([
      owner,
      query.project ?? null,
      query.agent ?? null,
      query.teams ?? null,
    ]);
    const cursor = query.cursor
      ? decodeCursor(
          query.cursor,
          ListCursor,
          "Invalid thread page cursor.",
          1024,
        )
      : null;
    if (cursor && cursor.binding !== scope)
      throw new Problem(
        400,
        "Thread page cursor belongs to another selection.",
      );
    const page = doneThreadsQueries.page(
      db,
      owner,
      cursor?.at ?? null,
      cursor?.id ?? "",
      DONE_THREAD_PAGE_ITEMS + 1,
    );
    const threads: DoneThreadSummary[] = [];
    let bytes = 2048,
      consumed = 0;
    for (const row of page.slice(0, DONE_THREAD_PAGE_ITEMS)) {
      const value = summary(owner, row, selected);
      const size = value ? Buffer.byteLength(JSON.stringify(value)) + 1 : 0;
      if (bytes + size > DONE_THREAD_PAGE_BYTES) {
        if (!threads.length) throw tooLarge();
        break;
      }
      consumed++;
      bytes += size;
      if (value) threads.push(value);
    }
    const last = page[consumed - 1];
    return {
      threads,
      next:
        last && consumed < page.length
          ? encodeCursor({ binding: scope, at: last.created_at, id: last.id })
          : null,
    };
  })();
}
export function readDoneThread(owner: string, id: string): DoneThreadDetail {
  return db.transaction(() => {
    const row = owned(owner, id);
    const result = cards(owner, cardIds(owner, id), true).sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    );
    return {
      thread: describe(
        row,
        result.map((card) => card.id),
      ),
      cards: result,
    };
  })();
}

export function readDoneThreadPage(
  owner: string,
  id: string,
  token?: string,
): DoneThreadDetailPage {
  return db.transaction(() => {
    const detail = readDoneThread(owner, id);
    const scope = binding([owner, id, detail.thread.cardIds]);
    const cursor = token
      ? decodeCursor(token, DetailCursor, "Invalid thread page cursor.", 1024)
      : null;
    const position = cursor
      ? detail.cards.findIndex((card) => card.id === cursor.after)
      : -1;
    if (cursor && (cursor.binding !== scope || position < 0))
      throw new Problem(
        409,
        "Thread membership changed. Refresh to read it again.",
      );
    let bytes =
      Buffer.byteLength(JSON.stringify({ thread: detail.thread })) + 2048;
    const page: DoneThreadDetail["cards"] = [];
    for (const card of detail.cards.slice(position + 1)) {
      const size = Buffer.byteLength(JSON.stringify(card)) + 1;
      if (
        page.length === DONE_THREAD_PAGE_ITEMS ||
        bytes + size > DONE_THREAD_PAGE_BYTES
      ) {
        if (!page.length) throw tooLarge();
        break;
      }
      bytes += size;
      page.push(card);
    }
    const last = page.at(-1);
    return {
      thread: detail.thread,
      cards: page,
      next:
        last && position + 1 + page.length < detail.cards.length
          ? encodeCursor({ binding: scope, after: last.id })
          : null,
    };
  })();
}
/** A saved thread's read state applies to every member result. */
export function setDoneThreadRead(
  owner: string,
  id: string,
  read: boolean,
  versions: Record<string, number> = {},
) {
  return db
    .transaction(() => {
      assertFleetAction(owner);
      owned(owner, id);
      const results = doneThreadMembersQueries.results(db, owner, id);
      const unreadVersions: Record<string, number> = {};
      const time = now();
      for (const card of results) {
        if (read) {
          if (
            (versions[card.card_id] ?? 0) ===
            doneUnreadVersion(owner, card.conversation_id, card.card_key)
          )
            doneCardReadsQueries.insert(
              db,
              owner,
              card.conversation_id,
              card.card_key,
              time,
            );
        } else {
          doneCardReadsQueries.remove(
            db,
            owner,
            card.conversation_id,
            card.card_key,
          );
          unreadVersions[card.card_id] = advanceDoneUnreadVersion(
            owner,
            card.conversation_id,
            card.card_key,
          );
        }
      }
      if (!read) {
        emit(owner, { kind: "collection", id: "feed" }, "invalidate", {
          scope: { kind: "collection", id: "feed" },
        });
        return { ok: true, unreadVersions };
      }
      return { ok: true };
    })
    .immediate();
}
function changed(owner: string) {
  doneThreadsQueries.prune(db, owner);
  emit(owner, { kind: "collection", id: "feed" }, "invalidate", {
    scope: { kind: "collection", id: "feed" },
  });
}
function move(owner: string, id: string, input: string[]) {
  const ids = [...new Set(input)];
  const result = cards(owner, ids);
  if (result.length !== ids.length)
    throw new Problem(404, "One or more Done cards are unavailable");
  const combined = new Set([...cardIds(owner, id), ...ids]);
  if (combined.size > MAX_DONE_THREAD_MEMBERS)
    throw new Problem(
      400,
      `A thread can contain up to ${MAX_DONE_THREAD_MEMBERS} cards`,
    );
  if (combined.size < 2)
    throw new Problem(400, "Select at least two cards for a new thread");
  for (const card of result)
    doneThreadMembersQueries.move(
      db,
      owner,
      card.id,
      id,
      card.source.conversation_id,
    );
  changed(owner);
  return describe(owned(owner, id), cardIds(owner, id));
}
export function createDoneThread(
  owner: string,
  input: { id: string; title: string; cardIds: string[] },
) {
  return db
    .transaction(() => {
      assertFleetAction(owner);
      // A lost response recovers this grouping without moving its cards again.
      const prior = doneThreadCreationsQueries.owner(db, input.id);
      if (prior)
        return describe(owned(owner, input.id), cardIds(owner, input.id));
      doneThreadCreationsQueries.insert(db, input.id, owner);
      doneThreadsQueries.insert(db, input.id, owner, input.title, now());
      return move(owner, input.id, input.cardIds);
    })
    .immediate();
}
export function moveDoneThreadCards(owner: string, id: string, ids: string[]) {
  return db
    .transaction(() => {
      assertFleetAction(owner);
      owned(owner, id);
      return move(owner, id, ids);
    })
    .immediate();
}
export function removeDoneThread(owner: string, id: string, card?: string) {
  return db
    .transaction(() => {
      assertFleetAction(owner);
      owned(owner, id);
      if (card) doneThreadMembersQueries.remove(db, owner, id, card);
      else doneThreadsQueries.remove(db, owner, id);
      changed(owner);
      return { ok: true };
    })
    .immediate();
}

type DoneThreadSummary = z.input<
  typeof import("../shared/done-threads.js").DoneThreadSummary
>;

type DoneThreadDetail = z.input<
  typeof import("../shared/done-threads.js").DoneThreadDetail
>;

type DoneThreadDetailPage = z.input<
  typeof import("../shared/done-threads.js").DoneThreadDetailPage
>;

type DoneThreadListPage = z.input<
  typeof import("../shared/done-threads.js").DoneThreadListPage
>;
