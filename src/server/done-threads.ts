import { db, now, emit } from "./db.js";
import { ownedAgent, ownedFolder, Problem } from "./domain.js";
import { doneCards } from "./done-cards.js";
import { projectFolders } from "./results.js";
import { teamFilter } from "./teams.js";
import type {
  DoneThread,
  DoneThreadDetail,
  DoneThreadQuery,
  DoneThreadSummary,
} from "../shared/done-threads.js";

type ThreadRow = { id: string; title: string; created_at: number };
const rows = db.prepare(
  "SELECT id,title,created_at FROM done_threads WHERE owner_id=? ORDER BY created_at DESC,id",
);
const members = db.prepare(
  "SELECT card_id FROM done_thread_members WHERE owner_id=? AND thread_id=? ORDER BY card_id",
);
function owned(owner: string, id: string): ThreadRow {
  const row = db
    .prepare(
      "SELECT id,title,created_at FROM done_threads WHERE owner_id=? AND id=?",
    )
    .get(owner, id) as ThreadRow | undefined;
  if (!row) throw new Problem(404, "Thread not found");
  return row;
}
function cardIds(owner: string, id: string) {
  return (members.all(owner, id) as { card_id: string }[]).map(
    (row) => row.card_id,
  );
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
    // individual Done cards, including when an older client dismisses a member.
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
export function listDoneThreads(
  owner: string,
  query: DoneThreadQuery = {},
): DoneThreadSummary[] {
  return db.transaction(() => {
    if (query.agent) ownedAgent(query.agent, owner);
    if (query.project) ownedFolder(query.project, owner);
    const folders = query.project ? projectFolders(owner, query.project) : null;
    const teams = teamFilter(query.teams, owner);
    return (rows.all(owner) as ThreadRow[]).flatMap((row) => {
      const visible = cards(owner, cardIds(owner, row.id));
      // Use the feed's own scope and team visibility rules for its preview,
      // while preserving the full membership for the reader and move actions.
      const preview =
        cards(
          owner,
          visible.map((card) => card.id),
          false,
          {
            folders,
            teamIds: teams,
            agent: query.agent,
          },
        )[0] ?? null;
      return visible.length
        ? [
            {
              ...describe(
                row,
                visible.map((card) => card.id),
              ),
              preview,
            },
          ]
        : [];
    });
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
function changed(owner: string) {
  db.prepare(
    "DELETE FROM done_threads WHERE owner_id=? AND (SELECT count(*) FROM done_thread_members m WHERE m.owner_id=done_threads.owner_id AND m.thread_id=done_threads.id)<2",
  ).run(owner);
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
  if (combined.size > 100)
    throw new Problem(400, "A thread can contain up to 100 cards");
  if (combined.size < 2)
    throw new Problem(400, "Select at least two cards for a new thread");
  const insert =
    db.prepare(`INSERT INTO done_thread_members(owner_id,card_id,thread_id,conversation_id) VALUES(?,?,?,?)
    ON CONFLICT(owner_id,card_id) DO UPDATE SET thread_id=excluded.thread_id,conversation_id=excluded.conversation_id`);
  for (const card of result)
    insert.run(owner, card.id, id, card.source.conversation_id);
  changed(owner);
  return describe(owned(owner, id), cardIds(owner, id));
}
export function createDoneThread(
  owner: string,
  input: { id: string; title: string; cardIds: string[] },
) {
  return db
    .transaction(() => {
      // A lost response recovers this grouping without moving its cards again.
      const prior = db
        .prepare("SELECT owner_id FROM done_thread_creations WHERE id=?")
        .get(input.id) as { owner_id: string } | undefined;
      if (prior)
        return describe(owned(owner, input.id), cardIds(owner, input.id));
      db.prepare(
        "INSERT INTO done_thread_creations(id,owner_id) VALUES(?,?)",
      ).run(input.id, owner);
      db.prepare(
        "INSERT INTO done_threads(id,owner_id,title,created_at) VALUES(?,?,?,?)",
      ).run(input.id, owner, input.title, now());
      return move(owner, input.id, input.cardIds);
    })
    .immediate();
}
export function moveDoneThreadCards(owner: string, id: string, ids: string[]) {
  return db
    .transaction(() => {
      owned(owner, id);
      return move(owner, id, ids);
    })
    .immediate();
}
export function removeDoneThread(owner: string, id: string, card?: string) {
  return db
    .transaction(() => {
      owned(owner, id);
      if (card)
        db.prepare(
          "DELETE FROM done_thread_members WHERE owner_id=? AND thread_id=? AND card_id=?",
        ).run(owner, id, card);
      else
        db.prepare("DELETE FROM done_threads WHERE owner_id=? AND id=?").run(
          owner,
          id,
        );
      changed(owner);
      return { ok: true };
    })
    .immediate();
}
