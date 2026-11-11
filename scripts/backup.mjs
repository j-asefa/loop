import Database from "better-sqlite3";
import { resolve } from "node:path";
import {
  workspaceDataDirectory,
  workspaceDatabasePath,
} from "../src/server/data-directory.ts";
import { chmodSync } from "node:fs";
const target = process.argv[2];
if (!target)
  throw new Error("Supply a backup filename outside the live data directory");
const db = new Database(
  workspaceDatabasePath(workspaceDataDirectory(process.env.LOOP_DATA_DIR)),
  { readonly: true, fileMustExist: true },
);
await db.backup(resolve(target));
chmodSync(target, 0o600);
db.close();
console.log(
  "Consistent SQLite backup completed. Store encryption keys separately.",
);
