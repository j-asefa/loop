// Migration 148 drops the workflow tables only when nothing remains in them.
// Any workflow record fails the production runner's startup transaction and
// leaves every table in place.
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/server/migrations";

const TABLES = ["workflows", "workflow_versions", "workflow_steps"];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function beforeRemoval() {
  const dir = mkdtempSync(join(tmpdir(), "loop-workflow-removal-"));
  dirs.push(dir);
  const old = join(dir, "migrations");
  mkdirSync(old);
  for (const file of readdirSync("migrations").filter(
    (file) => file.endsWith(".sql") && Number(file.split("-")[0]) < 148,
  ))
    copyFileSync(join("migrations", file), join(old, file));
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  applyMigrations(db, old);
  return db;
}
const tables = (db: Database.Database) =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => "?").join(",")}) ORDER BY name`,
      )
      .all(...TABLES) as { name: string }[]
  ).map((row) => row.name);
const applied = (db: Database.Database) =>
  db
    .prepare("SELECT 1 FROM schema_migrations WHERE name='remove-workflows'")
    .get();
function run(
  db: Database.Database,
  id: string,
  kind = "agent",
  payload = "{}",
) {
  db.prepare(
    "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,'owner',?,'Task','completed',?,?,1,1)",
  ).run(id, kind, id, payload);
}

it("drops the empty workflow tables and keeps other runs", () => {
  const db = beforeRemoval();
  try {
    run(db, "agent-run");
    // The card_runs_folder expression index (migration 119) keeps every
    // stored run payload valid JSON, so the guard never reads a malformed one.
    expect(() => run(db, "malformed-run", "agent", "{")).toThrow(
      /malformed JSON/,
    );
    expect(tables(db)).toEqual([...TABLES].sort());
    applyMigrations(db);
    expect(tables(db)).toEqual([]);
    expect(applied(db)).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='workflow_removal_guard' OR sql LIKE '%workflow_steps%'",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("SELECT id FROM runs").all()).toEqual([
      { id: "agent-run" },
    ]);
  } finally {
    db.close();
  }
});

it.each([
  [
    "a workflow",
    (db: Database.Database) =>
      db
        .prepare("INSERT INTO workflows VALUES('w','owner','W',1,'{}','{}',1)")
        .run(),
  ],
  [
    "a workflow step",
    (db: Database.Database) => {
      run(db, "parent");
      db.prepare(
        "INSERT INTO workflow_steps(run_id,step_id,position,state) VALUES('parent','s',0,'completed')",
      ).run();
    },
  ],
  ["a workflow run", (db: Database.Database) => run(db, "w-run", "workflow")],
  [
    "a run started by a workflow step without its parent",
    (db: Database.Database) =>
      run(db, "orphan", "agent", JSON.stringify({ workflowRun: "gone" })),
  ],
])("refuses to drop anything while %s remains", (_name, seed) => {
  const db = beforeRemoval();
  try {
    seed(db);
    expect(() => applyMigrations(db)).toThrow(/Workflow records remain/);
    expect(tables(db)).toEqual([...TABLES].sort());
    expect(applied(db)).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='workflow_removal_guard'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
