import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/backup.mjs", import.meta.url));
for (const mode of ["default", "empty", "relative", "absolute"] as const) {
  test(`standalone backup resolves the ${mode} data directory and copies committed state`, () => {
    const root = mkdtempSync(join(tmpdir(), "loop-backup-"));
    const data = join(
      root,
      mode === "relative" || mode === "absolute" ? "custom" : "data",
    );
    mkdirSync(data);
    const source = new Database(join(data, "loop.db"));
    let backup: Database.Database | undefined;
    try {
      source.pragma("journal_mode = WAL");
      source.exec(
        "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('committed'); BEGIN IMMEDIATE; INSERT INTO evidence VALUES('uncommitted');",
      );
      const env = { ...process.env };
      delete env.LOOP_DATA_DIR;
      if (mode === "empty") env.LOOP_DATA_DIR = "";
      if (mode === "relative") env.LOOP_DATA_DIR = "custom";
      if (mode === "absolute") env.LOOP_DATA_DIR = data;
      const target = join(root, "backup.db");
      const result = spawnSync(process.execPath, [script, target], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Consistent SQLite backup completed/);
      backup = new Database(target, { readonly: true, fileMustExist: true });
      assert.deepEqual(backup.prepare("SELECT * FROM evidence").all(), [
        { value: "committed" },
      ]);
      assert.equal(statSync(target).mode & 0o777, 0o600);
    } finally {
      backup?.close();
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("backup refuses a missing source without creating its data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-backup-missing-"));
  try {
    const data = join(root, "missing");
    const target = join(root, "backup.db");
    const result = spawnSync(process.execPath, [script, target], {
      cwd: root,
      env: { ...process.env, LOOP_DATA_DIR: data },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(data), false);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
