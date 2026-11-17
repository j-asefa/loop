import { until } from "./helpers.js";
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("applies the longer migration wait before acquiring the startup lock and restores the write timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-migration-lock-"));
  const env = {
    ...process.env,
    LOOP_DATA_DIR: dir,
  };
  let locked: Database.Database | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "const {db}=await import('./src/server/db.ts');db.close();",
      ],
      { env },
    );
    locked = new Database(join(dir, "loop.db"));
    locked.exec("BEGIN IMMEDIATE");
    // This holds the same lock as the API's backfill while the worker starts.
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import Database from 'better-sqlite3';
const {startDatabase}=await import('./src/server/database-startup.ts');
let busy=0;
const db=new Database(process.env.LOOP_DATA_DIR+'/loop.db', {verbose(sql) {
  const policy=/^PRAGMA busy_timeout = (\\d+)/i.exec(sql);
  if (policy) busy=Number(policy[1]);
  if (sql==='BEGIN IMMEDIATE') console.log('migration-timeout='+busy);
}});
startDatabase(db,()=>{});
console.log('timeout='+db.pragma('busy_timeout',{simple:true}));
db.close();`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      errors += chunk;
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", resolve);
    });
    // The trace marks the actual startup transaction while the parent owns
    // its lock. Inspect its configured wait instead of holding it for 6.5 s.
    await until(() => /migration-timeout=\d+/.test(output), 5000);
    const migrationWait = Number(/migration-timeout=(\d+)/.exec(output)![1]);
    locked.exec("COMMIT");
    expect(await finished, errors).toBe(0);
    expect(output).toContain("timeout=5000");
    const writeWait = Number(/^timeout=(\d+)/m.exec(output)![1]);
    expect(migrationWait).toBeGreaterThan(writeWait);
  } finally {
    child?.kill();
    if (locked?.inTransaction) locked.exec("ROLLBACK");
    locked?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

// The production database entry refuses pre-unification layouts.
function openDatabase(dir: string) {
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "const {db}=await import('./src/server/db.ts');db.close();",
      ],
      {
        env: { ...process.env, LOOP_DATA_DIR: dir },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr);
  }
}

it("rejects pre-unification databases before migrating them", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-pre-unification-"));
  try {
    const database = new Database(join(dir, "loop.db"));
    database.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES(1,0)",
    );
    database.close();
    expect(openDatabase(dir)).toContain(
      "Earlier Loop database layouts are unsupported",
    );
    const unchanged = new Database(join(dir, "loop.db"));
    expect(unchanged.prepare("SELECT * FROM schema_version").all()).toEqual([
      { version: 1, applied_at: 0 },
    ]);
    expect(
      unchanged
        .prepare("SELECT 1 FROM sqlite_master WHERE name='deployment_profile'")
        .get(),
    ).toBeUndefined();
    unchanged.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

it("registers Unicode search normalization when the database opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-search-startup-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {db}=await import('./src/server/db.ts');
       console.log(JSON.stringify(db.prepare('SELECT card_lower(?) value, card_lower(NULL) absent').get('CAFE\\u0301')));
       db.close();`,
      ],
      { env: { ...process.env, LOOP_DATA_DIR: dir }, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({ value: "café", absent: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
