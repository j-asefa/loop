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
import { expect, it } from "vitest";
import { applyMigrations } from "../src/server/migrations";

it("creates core pairing tables and enforces agent-bound native sessions without retired storage", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  try {
    applyMigrations(db);
    const objects = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]
      ).map((row) => row.name),
    );
    for (const name of [
      "devices",
      "device_store",
      "pairing_ceremonies",
      "pairing_clock",
      "search_fts",
    ])
      expect(objects.has(name), name).toBe(true);
    for (const name of [
      "fleet_devices",
      "fleet_device_store",
      "fleet_pairing_ceremonies",
      "fleet_pairing_clock",
      "artifact_fts",
      "native_sessions",
      "native_dispatches",
      "native_permissions",
      "native_projection",
      "execution_environments",
      "environment_projects",
      "legacy_imports",
      "pr_watch_registrations",
      "search_vectors",
      "feed_cards_legacy",
    ])
      expect(objects.has(name), name).toBe(false);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('conversation','owner','Current session',0)",
    ).run();
    const insert = db.prepare(
      "INSERT INTO companion_sessions(conversation_id,harness,project,updated_at,worktree_agent_id) VALUES('conversation','codex','/fixture',0,?)",
    );
    expect(() => insert.run(null)).toThrow(/NOT NULL/);
    insert.run("current-agent");
    expect(
      db.prepare("SELECT worktree_agent_id FROM companion_sessions").get(),
    ).toEqual({ worktree_agent_id: "current-agent" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  } finally {
    db.close();
  }
});

it("starts a named-ledger database whose earlier binding has no agent identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-core-schema-"));
  const before = join(dir, "migrations");
  mkdirSync(before);
  for (const file of readdirSync("migrations").filter(
    (file) => file.endsWith(".sql") && Number(file.split("-")[0]) < 152,
  ))
    copyFileSync(join("migrations", file), join(before, file));
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  try {
    applyMigrations(db, before);
    const conversation = db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','Session',0)",
    );
    const binding = db.prepare(
      "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,updated_at,effort,permission_mode,worktree_source,worktree_agent_id) VALUES(?,'codex',?,'/fixture',7,'high','auto','main',?)",
    );
    conversation.run("unbound");
    binding.run("unbound", "native-unbound", null);
    conversation.run("bound");
    binding.run("bound", "native-bound", "agent");
    applyMigrations(db);
    expect(
      db
        .prepare(
          "SELECT conversation_id,native_id,updated_at,effort,permission_mode,worktree_source,worktree_agent_id FROM companion_sessions",
        )
        .all(),
    ).toEqual([
      {
        conversation_id: "bound",
        native_id: "native-bound",
        updated_at: 7,
        effort: "high",
        permission_mode: "auto",
        worktree_source: "main",
        worktree_agent_id: "agent",
      },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
