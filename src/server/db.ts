import { startDatabase } from "./database-startup.js";
import * as eventQueries from "./sql/events.js";
import * as watermarkQueries from "./sql/change-watermark.js";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { changeClock, createDeadlineScheduler } from "./change-deadlines.js";
import { createChangeBus } from "./changes.js";
import { eventSubjects } from "./event-subjects.js";
import {
  parseEmission,
  type WorkspaceEmission,
  type WorkspaceSubject,
} from "../shared/workspace-events.js";
export const db: Database.Database = new Database(config.database);
const subjects = eventSubjects(db);
let wakeChanges = () => {};
startDatabase(db, emit);
export function now() {
  return Date.now();
}
export function id() {
  return crypto.randomUUID();
}
export const changes = createChangeBus(db, { pollMs: config.changePollMs });
wakeChanges = changes.wake;
export const deadlines = createDeadlineScheduler(db, changes);
export function workspaceClock(owner: string) {
  return { ...changeClock(db, owner), ...watermarkQueries.snapshot(db, owner) };
}
export function ensureWorkspaceOwner(owner: string): string {
  return watermarkQueries.ensureOwner(db, owner);
}
// Capture before deleting a subject, inside the deletion transaction.
export function emit(
  owner: string,
  input: string | WorkspaceSubject,
  ...[type, payload]: WorkspaceEmission
) {
  return db
    .transaction(() => {
      const subject = subjects.resolve(owner, input);
      const run = subject.kind === "run" ? subject.id : null;
      if (type === "tombstone") subjects.resolve(owner, payload.removed);
      parseEmission(run, type, payload, subject);
      const row = eventQueries.insert(db, {
        owner_id: owner,
        run_id: run,
        type,
        payload: JSON.stringify(payload),
        created_at: now(),
        subject_kind: subject.kind,
        subject_id: subject.id,
      });
      wakeChanges();
      return row;
    })
    .immediate();
}
