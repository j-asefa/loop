import * as runsQueries from "../sql/runs.js";
import { db } from "../db.js";
import { ownedConversation } from "../domain.js";
import { collapse, contains } from "./shared.js";
import { conversationReturnState } from "./reading-position.js";

// ---------------------------------------------------------------------------
// 4. Outline
type OutlineItem = {
  message_id: string;
  kind: "prompt" | "result" | "approval" | "failure" | "saved";
  preview: string;
  created_at: number;
  run_id: string | null;
};
export function conversationOutline(
  owner: string,
  conversation: string,
  q?: string,
) {
  ownedConversation(conversation, owner);
  if (q?.trim())
    return { items: [], matches: threadMatches(owner, conversation, q.trim()) };
  const messages = db
    .prepare(
      "SELECT id,run_id,role,substr(content,1,1000) content,created_at,rowid seq FROM messages WHERE owner_id=? AND conversation_id=? AND json_extract(metadata,'$.progress') IS NOT 1 ORDER BY created_at,rowid",
    )
    .all(owner, conversation) as {
    id: string;
    run_id: string | null;
    role: string;
    content: string;
    created_at: number;
    seq: number;
  }[];
  const runs = runsQueries.outline(db, owner, conversation) as {
    id: string;
    state: string;
    error: string | null;
    approvals: number;
  }[];
  const saved = new Set(conversationReturnState(owner, conversation).saved);
  const order = new Map(messages.map((m) => [m.id, m.seq]));
  const items: OutlineItem[] = [];
  const add = (
    m: (typeof messages)[number],
    kind: OutlineItem["kind"],
    preview = collapse(m.content, 200),
  ) =>
    items.push({
      message_id: m.id,
      kind,
      preview,
      created_at: m.created_at,
      run_id: m.run_id,
    });
  for (const m of messages) if (m.role === "user") add(m, "prompt");
  for (const run of runs) {
    const own = messages.filter((m) => m.run_id === run.id);
    const last = own.at(-1);
    if (!last) continue;
    const answer = own.filter((m) => m.role !== "user").at(-1);
    if (run.state === "completed" && answer) add(answer, "result");
    if (["failed", "interrupted"].includes(run.state))
      add(
        last,
        "failure",
        collapse(run.error, 200) ||
          (run.state === "failed" ? "Run failed" : "Run interrupted"),
      );
    // Never expose tool arguments here; the approval card holds them.
    if (run.approvals > 0)
      add(
        last,
        "approval",
        run.approvals > 1
          ? `${run.approvals} approvals requested`
          : "Approval requested",
      );
  }
  for (const m of messages) if (saved.has(m.id)) add(m, "saved");
  const rank = { prompt: 0, approval: 1, failure: 2, result: 3, saved: 4 };
  items.sort(
    (a, b) =>
      a.created_at - b.created_at ||
      order.get(a.message_id)! - order.get(b.message_id)! ||
      rank[a.kind] - rank[b.kind],
  );
  return { items };
}

/**
 * Text search inside one thread, across every kind of message: your prompts,
 * the agent's answers and progress updates, results, failures and saved
 * messages. Each match says what it is, so no filter has to be guessed first.
 * Approval requests are not searched: their arguments stay on the card.
 */
type ThreadMatch = {
  message_id: string;
  kind: "prompt" | "response" | "update" | "result" | "failure";
  saved: boolean;
  preview: string;
  created_at: number;
};
function threadMatches(owner: string, conversation: string, q: string) {
  const pattern = contains(q);
  const rows = db
    .prepare(
      `SELECT m.id,m.role,m.run_id,m.content,m.created_at,
        COALESCE(json_extract(m.metadata,'$.progress'),0) progress,r.state run_state,r.error run_error,
        m.id=(SELECT f.id FROM messages f WHERE f.owner_id=m.owner_id AND f.conversation_id=m.conversation_id AND f.run_id=m.run_id
          AND f.role='assistant' AND COALESCE(json_extract(f.metadata,'$.progress'),0)=0 AND length(trim(f.content))>0
          ORDER BY f.created_at DESC,f.rowid DESC LIMIT 1) final,
        m.id=(SELECT l.id FROM messages l WHERE l.owner_id=m.owner_id AND l.conversation_id=m.conversation_id AND l.run_id=m.run_id
          ORDER BY l.created_at DESC,l.rowid DESC LIMIT 1) last
      FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.owner_id=m.owner_id
      WHERE m.owner_id=@owner AND m.conversation_id=@conversation
        AND NOT (json_extract(m.metadata,'$.progress') IS 1 AND json_extract(m.metadata,'$.final') IS 1)
        AND (m.content LIKE @q ESCAPE '\\' OR (r.state IN ('failed','interrupted') AND r.error LIKE @q ESCAPE '\\'))
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 100`,
    )
    .all({ owner, conversation, q: pattern }) as {
    id: string;
    role: string;
    run_id: string | null;
    content: string;
    created_at: number;
    progress: number;
    run_state: string | null;
    run_error: string | null;
    final: number;
    last: number;
  }[];
  const saved = new Set(conversationReturnState(owner, conversation).saved);
  const needle = q.toLowerCase();
  const matches: ThreadMatch[] = [];
  for (const row of rows) {
    const failed =
      ["failed", "interrupted"].includes(row.run_state || "") && row.last;
    const inError =
      failed && (row.run_error || "").toLowerCase().includes(needle);
    const inText = row.content.toLowerCase().includes(needle);
    if (inText)
      matches.push({
        message_id: row.id,
        kind:
          row.role === "user"
            ? "prompt"
            : row.progress
              ? "update"
              : row.final && row.run_state === "completed"
                ? "result"
                : "response",
        saved: saved.has(row.id),
        preview: excerpt(row.content, needle),
        created_at: row.created_at,
      });
    if (inError)
      matches.push({
        message_id: row.id,
        kind: "failure",
        saved: saved.has(row.id),
        preview: excerpt(row.run_error!, needle),
        created_at: row.created_at,
      });
  }
  return matches;
}
/** About 160 characters around the first match, on one line. */
function excerpt(text: string, needle: string) {
  const flat = collapse(text, 30000);
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, 160);
  const start = Math.max(0, at - 60);
  return (
    (start ? "…" : "") +
    flat.slice(start, start + 160) +
    (start + 160 < flat.length ? "…" : "")
  );
}
