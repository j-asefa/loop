import { z } from "zod";
import { db, id, now } from "../db.js";
import { Problem } from "../domain.js";
import { recordChange } from "../project-changes.js";
import { checkQuote, resolveCite } from "./cites.js";
import { Cite, type Change, type Item } from "./schema.js";
import {
  active,
  assertProject,
  decodeItem,
  ledger,
  readState,
  section,
  selectView,
  type State,
  type View,
} from "./store.js";

export const itemKinds = [
  "state",
  "decision",
  "question",
  "unfinished",
] as const;
export const statuses = {
  state: ["active", "retired"],
  decision: ["active", "superseded", "reverted"],
  question: ["open", "answered", "dropped"],
  unfinished: ["open", "done"],
} as const;
const text = z.string().trim().min(1).max(240);
const patch = z
  .object({
    text: text.optional(),
    why: z.string().trim().max(240).optional(),
    status: z.string().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Choose a field to edit");

function stateForEdit(owner: string, project: string) {
  assertProject(owner, project);
  db.prepare(
    "INSERT OR IGNORE INTO brief_state(owner_id,project_id) VALUES(?,?)",
  ).run(owner, project);
  return readState(owner, project);
}
function publishEdit(state: State, change: Omit<Change, "since_version">) {
  const version = state.current_version + 1,
    rev = state.owner_edit_rev + 1,
    at = now();
  const previous = db
    .prepare(
      "SELECT view FROM project_briefs WHERE owner_id=? AND project_id=? AND version=? AND state='published'",
    )
    .get(state.owner_id, state.project_id, state.current_version) as
    { view: string } | undefined;
  const headline = previous
    ? (JSON.parse(previous.view) as View).headline
    : null;
  const view = selectView(ledger(state.owner_id, state.project_id), headline, [
    { ...change, since_version: version },
  ]);
  db.prepare(
    `INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,unincorporated_before,synth_at,
    connection_id,model,built_on_version,owner_edit_rev,state,idempotency_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?,?)`,
  ).run(
    id(),
    state.owner_id,
    state.project_id,
    version,
    JSON.stringify(view),
    state.basis_since ?? state.basis_through,
    state.basis_through,
    state.unincorporated_before,
    at,
    null,
    null,
    state.current_version,
    rev,
    `brief-owner:${state.project_id}:${rev}`,
    at,
  );
  db.prepare(
    "UPDATE brief_state SET current_version=?,owner_edit_rev=? WHERE owner_id=? AND project_id=?",
  ).run(version, rev, state.owner_id, state.project_id);
  recordChange(state.owner_id, state.project_id, "brief_edit", change.id);
}

export function setGoal(owner: string, project: string, input: unknown) {
  const { text } = z
    .object({ text: z.string().trim().max(200).nullable() })
    .strict()
    .parse(input);
  db.transaction(() => {
    const state = stateForEdit(owner, project),
      goal = text || null;
    if (state.goal === goal) return;
    db.prepare(
      "UPDATE brief_state SET goal=?,owner_edit_rev=owner_edit_rev+1 WHERE owner_id=? AND project_id=?",
    ).run(goal, owner, project);
    recordChange(owner, project, "brief_edit", "goal");
  }).immediate();
}

export function editItem(
  owner: string,
  project: string,
  itemId: string,
  input: unknown,
) {
  const data = patch.parse(input);
  db.transaction(() => {
    const state = stateForEdit(owner, project);
    const row = db
      .prepare(
        "SELECT * FROM brief_items WHERE owner_id=? AND project_id=? AND id=?",
      )
      .get(owner, project, itemId) as Record<string, any> | undefined;
    if (!row) throw new Problem(404, "Brief item not found");
    const item = decodeItem(row);
    if (data.why !== undefined && item.kind !== "decision")
      throw new Problem(400, "Only decisions have a rationale");
    if (
      data.status !== undefined &&
      !(statuses[item.kind] as readonly string[]).includes(data.status)
    )
      throw new Problem(400, "Status does not match this item");
    const words =
      (data.text !== undefined && data.text !== item.text) ||
      (data.why !== undefined && data.why !== (item.why ?? ""));
    const next = {
      ...item,
      ...data,
      pinned: words ? true : (data.pinned ?? item.pinned),
    };
    if (!words && next.status === item.status && next.pinned === item.pinned)
      return;
    db.prepare(
      `UPDATE brief_items SET text=?,why=?,status=?,pinned=?,author=?,owner_rev=owner_rev+1,last_version=?,updated_at=?
      WHERE owner_id=? AND project_id=? AND id=?`,
    ).run(
      next.text,
      next.why || null,
      next.status,
      Number(next.pinned),
      words ? "owner" : item.author,
      state.current_version + 1,
      now(),
      owner,
      project,
      itemId,
    );
    publishEdit(state, {
      op:
        active(item) && !active(next)
          ? ["answered", "done"].includes(next.status)
            ? "resolved"
            : "removed"
          : "changed",
      field: section[item.kind],
      id: itemId,
      pinned: next.pinned,
    });
  }).immediate();
}

export function addDecision(owner: string, project: string, input: unknown) {
  const data = z
    .object({
      kind: z.literal("decision"),
      text,
      why: z.string().trim().max(240).optional(),
      cite: z.array(Cite).min(1).max(20),
    })
    .strict()
    .parse(input);
  return db
    .transaction(() => {
      const state = stateForEdit(owner, project);
      const sources = data.cite.map((cite) => {
        const source = resolveCite(owner, project, cite);
        if (!source || !checkQuote(source.content, cite.quote))
          throw new Problem(
            400,
            "Each citation must resolve to matching text in this project",
          );
        return source;
      });
      const saved = sources.some(
        (source) =>
          source.kind === "saved" || (source.kind === "result" && source.saved),
      );
      const ownerMessage = sources.some(
        (source) =>
          source.kind === "message" &&
          source.role === "user" &&
          !source.automated,
      );
      if (!saved && !ownerMessage)
        throw new Problem(
          400,
          "Cite a result you saved or one of your messages to record a decision",
        );
      const itemId = "dec_" + id(),
        version = state.current_version + 1,
        at = now();
      db.prepare(
        `INSERT INTO brief_items(id,owner_id,project_id,kind,text,why,status,cites,evidence,decided_by,decided_at,author,pinned,first_version,last_version,owner_rev,created_at,updated_at)
      VALUES(?,?,?,'decision',?,?,'active',?,?,'you',?,'owner',1,?,?,1,?,?)`,
      ).run(
        itemId,
        owner,
        project,
        data.text,
        data.why || null,
        JSON.stringify(data.cite),
        saved ? "owner_saved" : "owner_message",
        at,
        version,
        version,
        at,
        at,
      );
      publishEdit(state, {
        op: "added",
        field: "decisions",
        id: itemId,
        pinned: true,
      });
      return itemId;
    })
    .immediate();
}
