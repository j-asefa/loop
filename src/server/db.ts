import { capabilities } from "./profile.js";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { changeClock, createDeadlineScheduler } from "./change-deadlines.js";
import { createChangeBus } from "./changes.js";
import { eventSubjects } from "./event-subjects.js";
import { parseEmission, type WorkspaceEmission, type WorkspaceSubject } from "../shared/workspace-events.js";
export const db: Database.Database = new Database(join(config.data, "loop.db"));
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
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)",
  );
  if (
    db.prepare("SELECT 1 FROM schema_version LIMIT 1").get() &&
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name IN ('deployment_profile','execution_environments')",
      )
      .get()
  )
    throw new Error(
      "Pre-unification databases are unsupported. Choose a fresh LOOP_DATA_DIR.",
    );
  // Both pre-merge branches used native_sessions and migration IDs 20/21.
  // Detect the actual schema, not the version number, and preserve both histories.
  const columns = db.pragma("table_info(native_sessions)") as {
    name: string;
  }[];
  if (columns.some((c) => c.name === "harness"))
    db.exec("ALTER TABLE native_sessions RENAME TO companion_sessions");
  if (
    columns.some((c) => c.name === "hub_session_id") &&
    !db.prepare("SELECT 1 FROM schema_version WHERE version=27").get()
  ) {
    db.exec(
      "INSERT OR IGNORE INTO schema_version VALUES(27,unixepoch()*1000); DELETE FROM schema_version WHERE version=20",
    );
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='memory_sources'")
        .get()
    )
      db.exec(
        "INSERT OR IGNORE INTO schema_version VALUES(28,unixepoch()*1000); DELETE FROM schema_version WHERE version=21",
      );
  }
  // The Pi customization branch used 40/41, then 42/43, before settling on
  // 43/44: main took 40/41 (trace search, reply excerpts) and 42 belongs to
  // PR watches. Move databases opened on that branch to the final numbers so
  // the migrations that own the old numbers still run.
  const version = (n: number) =>
    db.prepare("SELECT 1 FROM schema_version WHERE version=?").get(n);
  const table = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
  if (
    version(42) &&
    version(43) &&
    !version(44) &&
    table("pi_package_recovery")
  )
    db.exec(
      "UPDATE schema_version SET version=44 WHERE version=43; UPDATE schema_version SET version=43 WHERE version=42",
    );
  if (version(40) && table("pi_project_trust") && !table("trace_fts"))
    db.exec("UPDATE schema_version SET version=43 WHERE version=40");
  if (
    version(41) &&
    table("pi_package_recovery") &&
    !(db.pragma("table_info(scheduled_sends)") as { name: string }[]).some(
      (column) => column.name === "reply_excerpt",
    )
  )
    db.exec("UPDATE schema_version SET version=44 WHERE version=41");
  // The trace-envelope cleanup was 45 on its branch before main gave 45 to
  // PR watch history. A 45 without that table was the cleanup: it is 46.
  if (version(45) && !version(46) && !table("pr_watch_seen"))
    db.exec("UPDATE schema_version SET version=46 WHERE version=45");
  // The permission branch used 51 before main assigned it to Social feeds.
  // Preserve databases opened on that branch and let the feed migration run.
  if (
    version(51) &&
    !version(52) &&
    !table("feed_subscriptions") &&
    (db.pragma("table_info(mcp_preferences)") as { name: string }[]).some(
      (column) => column.name === "agent_permission_mode",
    )
  )
    db.exec("UPDATE schema_version SET version=52 WHERE version=51");
  // HAPI's permission lease used 68 before main assigned it to PR-watch
  // registrations. Preserve preview databases and let both migrations run.
  if (
    version(68) &&
    !version(69) &&
    (db.pragma("table_info(native_permissions)") as { name: string }[]).some(
      (column) => column.name === "delivery_expires_at",
    )
  ) {
    db.exec("INSERT INTO schema_version VALUES(69,unixepoch()*1000)");
    if (!table("pr_watch_registrations"))
      db.exec("DELETE FROM schema_version WHERE version=68");
  }
  // The native-restoration preview used 70 before team presets landed on main.
  // Identify that preview by schema and preserve its completed recovery without
  // skipping the team tables or running account recovery a second time.
  if (version(70) && !version(71) && !table("team_creations"))
    db.exec("UPDATE schema_version SET version=71 WHERE version=70");
  // Direct-mail previews used 80 before main assigned it to HAPI retirement.
  // Identify the completed mail schema so retirement still runs and mail is
  // not rebuilt a second time when upgrading a preview workspace.
  if (
    version(80) &&
    !version(83) &&
    (db.pragma("table_info(agent_threads)") as { name: string }[]).some(
      (column) => column.name === "scope",
    )
  )
    db.exec("UPDATE schema_version SET version=83 WHERE version=80");
  // Brief migrations 93/94 originally omitted their completion records.
  // Recognize the applied schema so restarting preserves usage and owner text.
  if (!version(93) && table("brief_generation_usage"))
    db.exec("INSERT INTO schema_version VALUES(93,unixepoch()*1000)");
  if (
    !version(94) &&
    (db.pragma("table_info(brief_items)") as { name: string }[]).some(
      (column) => column.name === "summary",
    )
  )
    db.exec("INSERT INTO schema_version VALUES(94,unixepoch()*1000)");
  for (const migration of readdirSync(
    new URL("../../migrations/", import.meta.url),
  )
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    db.transaction(() => {
      if (
        !db
          .prepare("SELECT 1 FROM schema_version WHERE version=?")
          .get(Number(migration.split("-")[0]))
      )
        db.exec(
          readFileSync(
            new URL("../../migrations/" + migration, import.meta.url),
            "utf8",
          ),
        );
    }).immediate();
  }
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO deployment_profile VALUES(1,?)").run(
      capabilities.profile,
    );
    const stored = db
      .prepare("SELECT profile FROM deployment_profile WHERE singleton=1")
      .get() as { profile: string };
    if (stored.profile !== capabilities.profile)
      throw new Error(
        `This data directory belongs to the ${stored.profile} profile. Choose a separate LOOP_DATA_DIR for ${capabilities.profile}.`,
      );
  }).immediate();
}).immediate();
db.pragma("busy_timeout = 5000");
export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export const changes = createChangeBus(db, { pollMs: config.changePollMs });
export const deadlines = createDeadlineScheduler(db, changes);
export function workspaceClock(owner: string) {
  const identity = db.prepare(`SELECT COALESCE(w.epoch,c.epoch) epoch,COALESCE(w.last_event_id,0) cursor
    FROM change_log_identity c LEFT JOIN change_watermark w ON w.owner_id=? WHERE c.singleton=1`)
    .get(owner) as { epoch: string; cursor: number };
  return { ...changeClock(db, owner), ...identity };
}
export function ensureWorkspaceOwner(owner: string): string {
  const existing = db.prepare("SELECT epoch FROM change_watermark WHERE owner_id=?").get(owner) as { epoch: string } | undefined;
  if (existing) return existing.epoch;
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO change_watermark(owner_id,last_event_id,epoch) SELECT ?,0,epoch FROM change_log_identity WHERE singleton=1").run(owner);
    return (db.prepare("SELECT epoch FROM change_watermark WHERE owner_id=?").get(owner) as { epoch: string }).epoch;
  }).immediate();
}
const subjects = eventSubjects(db);
// Capture before deleting a subject, inside the deletion transaction.
export const ownedEventSubject = subjects.prove;
export function emit(
  owner: string,
  input: string | WorkspaceSubject,
  ...[type, payload]: WorkspaceEmission
) {
  return db.transaction(() => {
    const subject = subjects.resolve(owner, input);
    const run = subject.kind === "run" ? subject.id : null;
    if (type === "tombstone") subjects.resolve(owner, payload.removed);
    parseEmission(run, type, payload, subject);
    const row = db
      .prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at,subject_kind,subject_id) VALUES(?,?,?,?,?,?,?)",
      )
      .run(owner, run, type, JSON.stringify(payload), now(), subject.kind, subject.id).lastInsertRowid;
    changes.wake();
    return row;
  }).immediate();
}
