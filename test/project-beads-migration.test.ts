import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/server/migrations";
import {
  getResult,
  publishImportedConversationResults,
} from "../src/server/result-publication";
import * as storeQueries from "../src/server/sql/project-bead-stores";
import * as receiptsQueries from "../src/server/sql/bead-write-receipts";
import { seedConversation, seedMessage } from "./helpers/seed";

it("preserves published answers and Beads references across migration and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-beads-upgrade-"));
  const existing = join(root, "loop.db");
  let db = new Database(existing);
  try {
    for (const filename of readdirSync("migrations").filter(
      (name) => name.endsWith(".sql") && name < "170-",
    ))
      symlinkSync(resolve("migrations", filename), join(root, filename));
    applyMigrations(db, root);

    const owner = "local-workspace";
    const project = "project";
    db.prepare(
      "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES(?,?,?,'project',1)",
    ).run(project, owner, "Historical project");
    const conversation = seedConversation(db, {
      id: "older-conversation",
      owner_id: owner,
      title: "Imported work",
      origin: "import",
      created_at: 1,
      project_id: project,
    });
    seedMessage(db, {
      id: "older-answer",
      owner_id: owner,
      conversation_id: conversation.id,
      role: "assistant",
      content: "An answer recorded before Beads.",
      created_at: 2,
    });
    const [saved] = publishImportedConversationResults(
      owner,
      conversation.id,
      db,
    );
    expect(saved.outcome.body).toBe("An answer recorded before Beads.");

    applyMigrations(db);
    expect(getResult(owner, saved.id, db)).toEqual(saved);
    storeQueries.bind(db, owner, project, "stable-bead-store");
    receiptsQueries.reserve(db, {
      owner_id: owner,
      store_id: "stable-bead-store",
      request_id: "request",
      operation: "create",
      request_hash: "digest",
      bead_id: "loop-issue",
      correlation_id: "correlation",
      source_result_id: saved.id,
    });
    receiptsQueries.finish(db, owner, "request", 3);
    db.close();

    db = new Database(existing);
    applyMigrations(db);
    expect(getResult(owner, saved.id, db)).toEqual(saved);
    expect(storeQueries.forProject(db, owner, project)?.store_id).toBe(
      "stable-bead-store",
    );
    expect(
      receiptsQueries.creation(db, owner, "stable-bead-store", "loop-issue")
        ?.source_result_id,
    ).toBe(saved.id);
    expect(storeQueries.forProject(db, "other", project)).toBeUndefined();
  } finally {
    db.close();
    rmSync(root, { force: true, recursive: true });
  }
});
