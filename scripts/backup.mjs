import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
const target = process.argv[2];
if (!target)
  throw new Error("Supply a backup filename outside the live data directory");
const db = new Database(
  resolve(process.env.LOOP_DATA_DIR || "data", "loop.db"),
  { readonly: true, fileMustExist: true },
);
await db.backup(resolve(target));
chmodSync(target, 0o600);
db.close();
const auth = new Database(
  resolve(process.env.LOOP_DATA_DIR || "data", "auth.db"),
  { readonly: true, fileMustExist: true },
);
await auth.backup(resolve(target + "-auth.db"));
chmodSync(target + "-auth.db", 0o600);
auth.close();
console.log(
  "Consistent SQLite backup completed. Store encryption keys separately.",
);
