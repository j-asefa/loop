// Migration 149 renames stored, application-owned names from Loop55 back to
// Loop. It never changes owners, credentials or uncertain work, and new rows
// keep the origin they are inserted with.
import Database from "better-sqlite3";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { applyMigrations } from "../src/server/migrations";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function before149() {
  const dir = mkdtempSync(join(tmpdir(), "loop-names-"));
  directories.push(dir);
  mkdirSync(join(dir, "migrations"));
  for (const file of readdirSync("migrations").filter(
    (file) => file.endsWith(".sql") && Number(file.split("-")[0]) < 149,
  ))
    copyFileSync(join("migrations", file), join(dir, "migrations", file));
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  applyMigrations(db, join(dir, "migrations"));
  return db;
}

it("renames stored Loop55 names without changing owners, credentials or uncertain work", () => {
  const db = before149();
  try {
    for (const owner of ["alice", "bob"]) {
      db.prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,'codex','Native','encrypted original','connected',?,1)",
      ).run(
        owner + "-connection",
        owner,
        JSON.stringify({
          loop55Harness: "codex",
          runtimeKind: "loop55-local",
          custom: "loop55_untouched",
        }),
      );
      // Migration 139's trigger stores new agents and threads as 'loop55'.
      db.prepare(
        "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'codex','m',1)",
      ).run(owner + "-agent", owner, owner, owner);
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Thread',1)",
      ).run(owner + "-thread", owner, owner + "-agent");
      db.prepare(
        "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,'agent','Original prompt','interrupted',?,?,1,1)",
      ).run(
        owner + "-run",
        owner,
        owner + "-identity",
        JSON.stringify({ uncertain: true, nativeSession: "loop55_original" }),
      );
      db.prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,'approval.decided',?,1)",
      ).run(
        owner,
        owner + "-run",
        JSON.stringify({
          approvalId: "a",
          decision: "approve",
          origin: "loop55",
        }),
      );
    }
    expect(db.prepare("SELECT DISTINCT origin FROM agents").all()).toEqual([
      { origin: "loop55" },
    ]);
    const runs = db.prepare("SELECT * FROM runs ORDER BY id").all();
    applyMigrations(db);
    expect(db.prepare("SELECT * FROM runs ORDER BY id").all()).toEqual(runs);
    for (const owner of ["alice", "bob"]) {
      const row = db
        .prepare("SELECT owner_id,secret,metadata FROM connections WHERE id=?")
        .get(owner + "-connection") as any;
      expect(row.owner_id).toBe(owner);
      expect(row.secret).toBe("encrypted original");
      expect(JSON.parse(row.metadata)).toEqual({
        loopHarness: "codex",
        runtimeKind: "loop-local",
        custom: "loop55_untouched",
      });
    }
    expect(db.prepare("SELECT DISTINCT origin FROM agents").all()).toEqual([
      { origin: "loop" },
    ]);
    expect(
      db.prepare("SELECT DISTINCT origin FROM conversations").all(),
    ).toEqual([{ origin: "loop" }]);
    expect(
      db
        .prepare(
          "SELECT DISTINCT json_extract(payload,'$.origin') o FROM events WHERE type='approval.decided'",
        )
        .all(),
    ).toEqual([{ o: "loop" }]);
    // New rows keep 'loop': the rewriting triggers are gone.
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('new','alice','new','new','codex','m',2)",
    ).run();
    expect(
      db.prepare("SELECT origin FROM agents WHERE id='new'").get(),
    ).toEqual({ origin: "loop" });
    const triggers = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger'")
      .all() as { sql: string }[];
    expect(triggers.filter((t) => /loop55/i.test(t.sql))).toEqual([]);
    expect(
      triggers.some((t) => t.sql.includes("Open Loop to review it.")),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it("keeps workspace settings and credentials out of test subprocesses", () => {
  const module = pathToFileURL(resolve("scripts/test-runner.mjs")).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { testEnvironment } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(testEnvironment({ PATH: "fixture", LOOP_HOME: "workspace", LOOP_ENCRYPTION_KEY: "fixture-secret", LOOP_TEST_FLAG: "test" }, "vitest")));`,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({
    PATH: "fixture",
    LOOP_TEST_FLAG: "test",
    LOOP_PROFILE: "companion",
  });
});
