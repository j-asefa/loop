import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("waits for another startup migration, then restores the normal write timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-migration-lock-"));
  const env = { ...process.env, LOOP_PROFILE: "server", LOOP_DATA_DIR: dir };
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
        "console.log('opening');const {db}=await import('./src/server/db.ts');console.log('timeout='+db.pragma('busy_timeout',{simple:true}));db.close();",
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
    await new Promise<void>((resolve) =>
      child!.stdout!.once("data", () => resolve()),
    );
    // The previous five-second startup timeout expires before this releases.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    locked.exec("COMMIT");
    expect(await finished, errors).toBe(0);
    expect(output).toContain("timeout=5000");
  } finally {
    child?.kill();
    if (locked?.inTransaction) locked.exec("ROLLBACK");
    locked?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
