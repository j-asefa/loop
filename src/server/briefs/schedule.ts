import { db, id, now } from "../db.js";
import type { State } from "./store.js";

export const COOLDOWN_MS = 15 * 60_000;
export const GENERATION_TIMEOUT_MS = 6 * 60_000;
const LEASE_MS = GENERATION_TIMEOUT_MS + 60_000;

export function markDue(owner: string, project: string, at = now()) {
  db.prepare(
    `UPDATE brief_state SET due_at=CASE WHEN due_at IS NULL
    THEN max(@at,COALESCE(last_run_at+@cooldown,0))
    ELSE min(due_at,max(@at,COALESCE(last_run_at+@cooldown,0))) END
    WHERE owner_id=@owner AND project_id=@project AND enabled=1`,
  ).run({ owner, project, at, cooldown: COOLDOWN_MS });
}

const due = `enabled=1 AND (
  (due_at<=@at AND (generation_id IS NULL OR lease_until<=@at))
  OR (generation_id IS NOT NULL AND lease_until<=@at))`;

export function dueProjects(at = now()): State[] {
  return db
    .prepare(
      `SELECT * FROM brief_state WHERE ${due}
    AND EXISTS(SELECT 1 FROM folders f WHERE f.id=project_id AND f.owner_id=brief_state.owner_id AND f.kind='project')
    ORDER BY COALESCE(due_at,lease_until),owner_id,project_id`,
    )
    .all({ at }) as State[];
}

export function claimDue(
  owner: string,
  project: string,
  at: number,
): State | undefined {
  return db
    .prepare(
      `UPDATE brief_state SET generation_id=@token,lease_until=@until,last_run_at=@at,due_at=NULL
    WHERE owner_id=@owner AND project_id=@project AND ${due} RETURNING *`,
    )
    .get({ owner, project, at, token: id(), until: at + LEASE_MS }) as
    State | undefined;
}
