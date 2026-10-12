import { db } from "../db.js";
import { owned, Problem } from "../domain.js";
import { limits, type Item, type Brief, type Change } from "./schema.js";

export function assertProject(owner: string, project: string) {
  if (owned<{ kind: string }>("folders", project, owner).kind !== "project")
    throw new Problem(404, "Project not found");
}
export type State = {
  owner_id: string;
  project_id: string;
  goal: string | null;
  current_version: number;
  basis_through: number;
  owner_edit_rev: number;
  due_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
};
export function readState(owner: string, project: string): State {
  return (
    (db
      .prepare("SELECT * FROM brief_state WHERE owner_id=? AND project_id=?")
      .get(owner, project) as State | undefined) ?? {
      owner_id: owner,
      project_id: project,
      goal: null,
      current_version: 0,
      basis_through: 0,
      owner_edit_rev: 0,
      due_at: null,
      last_run_at: null,
      last_error: null,
    }
  );
}
export type LedgerItem = Item & {
  owner_rev: number;
  created_at: number;
  updated_at: number;
};
export function ledger(owner: string, project: string): LedgerItem[] {
  return (
    db
      .prepare(
        "SELECT * FROM brief_items WHERE owner_id=? AND project_id=? ORDER BY id",
      )
      .all(owner, project) as Record<string, any>[]
  ).map(
    (r) =>
      ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        status: r.status,
        cite: JSON.parse(r.cites),
        pinned: !!r.pinned,
        cite_stale: !!r.cite_stale,
        author: r.author,
        first_version: r.first_version,
        last_version: r.last_version,
        owner_rev: r.owner_rev,
        created_at: r.created_at,
        updated_at: r.updated_at,
        ...Object.fromEntries(
          [
            "why",
            "evidence",
            "decided_by",
            "decided_at",
            "supersedes",
            "asked_by",
            "next",
            "blocker",
          ]
            .filter((k) => r[k] !== null)
            .map((k) => [k, r[k]]),
        ),
        ...(r.thread_id !== null && { thread: r.thread_id }),
        ...(r.answered_cite !== null && {
          answered_cite: JSON.parse(r.answered_cite),
        }),
      }) as LedgerItem,
  );
}
export function publicItem({
  owner_rev,
  created_at,
  updated_at,
  ...item
}: LedgerItem): Item {
  return item;
}
export const section = {
  state: "state",
  decision: "decisions",
  question: "open_questions",
  unfinished: "unfinished",
} as const;
export function active(item: Pick<Item, "kind" | "status">) {
  return (
    item.status ===
    (item.kind === "state" || item.kind === "decision" ? "active" : "open")
  );
}
export type View = {
  headline: Brief["headline"];
  overflow: Brief["overflow"];
  changes: Change[];
} & Record<keyof typeof limits, string[]>;
export function selectView(
  items: LedgerItem[],
  headline: Brief["headline"],
  changes: Change[] = [],
): View {
  const view: View = {
    headline,
    changes,
    state: [],
    decisions: [],
    open_questions: [],
    unfinished: [],
    overflow: { state: 0, decisions: 0, open_questions: 0, unfinished: 0 },
  };
  const sorted = items
    .filter(active)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.last_version - a.last_version ||
        b.updated_at - a.updated_at ||
        a.id.localeCompare(b.id),
    );
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const rows = sorted.filter((r) => section[r.kind] === key);
    view[key] = rows.slice(0, limits[key]).map((r) => r.id);
    view.overflow[key] = Math.max(0, rows.length - limits[key]);
  }
  return view;
}
export function conversationProject(
  owner: string,
  conversation: string,
): string | null {
  return (
    (
      db
        .prepare(
          `SELECT f.project_id FROM conversations c JOIN project_change_folders f
    ON f.owner_id=c.owner_id AND f.folder_id=COALESCE(c.project_id,(SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=c.owner_id AND r.conversation_id=c.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1))
    WHERE c.owner_id=? AND c.id=?`,
        )
        .get(owner, conversation) as { project_id: string } | undefined
    )?.project_id ?? null
  );
}

/** A watch follows explicit filing, otherwise its recorded event/creation scope.
 * Unrelated later runs must not move its earlier evidence to another project. */
export function watchProject(
  owner: string,
  watch: string,
  recordedProject?: string,
): string | null {
  return (
    (
      db
        .prepare(
          `SELECT f.project_id FROM pr_watches w
    JOIN conversations c ON c.id=w.conversation_id AND c.owner_id=w.owner_id
    JOIN project_change_folders f ON f.owner_id=w.owner_id AND f.folder_id=COALESCE(
      c.project_id,@recorded,
      (SELECT p.project_id FROM project_changes p WHERE p.owner_id=w.owner_id AND p.kind='pr_update'
        AND substr(p.ref,1,length(w.id)+1)=w.id||':' ORDER BY p.seq DESC LIMIT 1),
      (SELECT json_extract(r.payload,'$.folderId') FROM runs r WHERE r.owner_id=w.owner_id
        AND r.conversation_id=w.conversation_id AND r.created_at<=w.created_at ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1))
    WHERE w.owner_id=@owner AND w.id=@watch`,
        )
        .get({ owner, watch, recorded: recordedProject ?? null }) as
        { project_id: string } | undefined
    )?.project_id ?? null
  );
}
