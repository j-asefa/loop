import type Database from "better-sqlite3";
import { statement } from "./statement.js";

const insertOwnedStatement = statement(
  "INSERT OR IGNORE INTO conversation_pull_links\n    (owner_id,conversation_id,repo_owner,repo_name,number,created_at)\n    SELECT @owner,@conversation,@repoOwner,@repo,@number,@created WHERE EXISTS (\n      SELECT 1 FROM conversations WHERE id=@conversation AND owner_id=@owner)",
);
export function insertOwned(
  db: Database.Database,
  owner: string,
  conversation: string,
  repoOwner: string,
  repo: string,
  number: number,
  created: number,
) {
  return insertOwnedStatement(db).run({
    owner,
    conversation,
    repoOwner,
    repo,
    number,
    created,
  });
}
