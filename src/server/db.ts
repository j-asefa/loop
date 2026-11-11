import * as eventQueries from "./sql/events.js";
import * as watermarkQueries from "./sql/change-watermark.js";
import { installLocalEffectAuthority } from "./effect-authority.js";
import { refuseRecordedEffects } from "./recorded-effects.js";
import { projectFeed } from "./feed-projector.js";
import { installProjectionBoundary } from "./projected-database.js";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
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
// SQLite lower() is ASCII-only; search fields and queries need the same Unicode normalization.
db.function("card_lower", { deterministic: true }, (value) =>
  typeof value === "string" ? value.normalize("NFC").toLowerCase() : null,
);
const subjects = eventSubjects(db);
let wakeChanges = () => {};
db.pragma("busy_timeout = 5000");
// Simultaneous API/worker startup can hit SQLITE_BUSY while switching a fresh
// database to WAL, before SQLite can use its normal busy handler.
const walDeadline = performance.now() + 5000;
const walWait = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  try {
    db.pragma("journal_mode = WAL");
    break;
  } catch (error) {
    if (
      (error as { code?: string }).code !== "SQLITE_BUSY" ||
      performance.now() >= walDeadline
    )
      throw error;
    Atomics.wait(walWait, 0, 0, 50);
  }
}
db.pragma("foreign_keys = ON");
// A migration that rewrites stored history holds this lock for longer than a
// statement timeout. The API and worker start together, so the process that
// does not win the migration waits for it instead of failing to start.
db.pragma("busy_timeout = 120000");
// Mutating transactions must use .immediate(): API and worker processes share
// this WAL database. A deferred read snapshot cannot safely upgrade after
// another process commits, even with busy_timeout configured.
db.transaction(() => {
  applyMigrations(db);
  projectFeed(db, emit);
}).immediate();
installProjectionBoundary(db, () => projectFeed(db, emit));
installLocalEffectAuthority(refuseRecordedEffects(db));
db.pragma("busy_timeout = 5000");
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
