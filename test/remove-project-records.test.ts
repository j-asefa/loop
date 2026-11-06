import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("upgrades populated records, preserves source work and restarts without retired producers", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-remove-project-records-"));
  let db = new Database(join(dir, "loop.db"));
  try {
    db.pragma("foreign_keys = ON");
    for (const file of readdirSync("migrations")
      .filter((f) => f.endsWith(".sql") && f < "100")
      .sort())
      db.exec(readFileSync("migrations/" + file, "utf8"));
    db.exec(`
      INSERT INTO deployment_profile VALUES(1,'server');
      INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES('workspace','owner','Workspace','project',1),('project','owner','Named','project',1),('other','other-owner','Other','project',1);
      INSERT INTO workspace_projects VALUES('owner','workspace');
      INSERT INTO conversations(id,owner_id,title,created_at) VALUES('thread','owner','Keep this thread',1);
      INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES('run','owner','thread','Keep this run','completed','run','{}',1,1);
      INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES('message','owner','thread','user','Keep my words','{"brief_pr_refs":["old"],"preserved":true}',1);
      INSERT INTO artifacts(id,owner_id,conversation_id,title,kind,content,created_at,updated_at) VALUES('result','owner','thread','Keep my result','markdown','Original result',1,1);
      INSERT INTO message_bookmarks(owner_id,message_id,created_at) VALUES('owner','message',1);
      INSERT INTO brief_state(owner_id,project_id,goal,enabled,generation_id,lease_until) VALUES('owner','workspace','Old goal',1,'pending-generation',9999999999999);
      INSERT INTO brief_items(id,owner_id,project_id,kind,text,status,author,first_version,last_version,created_at,updated_at) VALUES('old','owner','workspace','decision','Old wording','superseded','owner',1,1,1,1);
      INSERT INTO brief_items(id,owner_id,project_id,kind,text,status,author,supersedes,first_version,last_version,created_at,updated_at) VALUES('new','owner','workspace','decision','Replacement wording','active','owner','old',2,2,2,2);
      INSERT INTO project_briefs(id,owner_id,project_id,version,view,basis_since,basis_through,synth_at,built_on_version,owner_edit_rev,state,idempotency_key,created_at) VALUES('brief','owner','workspace',2,'{}',0,1,1,1,0,'published','brief-key',1);
      INSERT INTO brief_acks VALUES('owner','workspace',2,1);
      INSERT INTO brief_deliveries VALUES('thread','owner','run',2,1);
      INSERT INTO brief_generation_usage VALUES('pending-generation','owner','workspace',1,'{}');
      INSERT INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state) VALUES('checkout','owner','run','agent','thread','/fixture','/fixture','main','sha',0,0,1,'captured');
      INSERT INTO run_checkout_versions VALUES('old-checkout','owner','run',1,'{}');
      INSERT INTO checkout_build_targets VALUES('checkout','owner','run','github.com/j-asefa/loop','sha','[]');
      INSERT INTO deployment_observations VALUES('observation','owner','workspace','checkout','run','thread','sha','included','fixture','[]','signature',1);
      DELETE FROM schema_version WHERE version IN (93,94);
    `);
    db.close();
    // Exercise the actual startup migrator, including the old 93/94 repair and a restart.
    for (let attempt = 0; attempt < 2; attempt++) {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          'const { db } = await import("./src/server/db.ts"); db.close();',
        ],
        {
          env: {
            ...process.env,
            LOOP_DATA_DIR: dir,
          },
          timeout: 30000,
          stdio: "pipe",
        },
      );
    }
    db = new Database(join(dir, "loop.db"));
    db.pragma("foreign_keys = ON");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'brief_%' OR name IN ('project_briefs','project_changes','deployment_observations','checkout_build_targets','run_checkout_versions')",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%project_changes%'",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .prepare("SELECT content,metadata FROM messages WHERE id='message'")
        .get(),
    ).toEqual({ content: "Keep my words", metadata: '{"preserved":true}' });
    expect(
      db.prepare("SELECT content FROM artifacts WHERE id='result'").get(),
    ).toEqual({ content: "Original result" });
    expect(db.prepare("SELECT * FROM message_bookmarks").all()).toHaveLength(1);
    expect(db.prepare("SELECT input FROM runs WHERE id='run'").get()).toEqual({
      input: "Keep this run",
    });
    expect(
      db.prepare("SELECT state FROM run_checkouts WHERE run_id='run'").get(),
    ).toEqual({ state: "captured" });
    // Moves, edits, saves and deletes still run their surviving production triggers.
    db.exec(`UPDATE conversations SET project_id='project' WHERE id='thread';
      UPDATE messages SET content='Edited words' WHERE id='message';
      UPDATE artifacts SET content='Edited result',pinned=1 WHERE id='result';
      UPDATE folders SET name='Renamed' WHERE id='project';
      DELETE FROM runs WHERE id='run';
      DELETE FROM messages WHERE id='message';
      DELETE FROM artifacts WHERE id='result';
      DELETE FROM conversations WHERE id='thread';
      DELETE FROM folders WHERE id='project';`);
    expect(db.prepare("SELECT * FROM run_checkouts").all()).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT project_id FROM project_change_folders WHERE owner_id='owner' AND folder_id IS NULL",
        )
        .get(),
    ).toEqual({ project_id: "workspace" });
    expect(
      db
        .prepare(
          "SELECT * FROM project_change_folders WHERE owner_id='other-owner' AND folder_id IS NULL",
        )
        .all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT count(*) n FROM feed_revisions").get(),
    ).toMatchObject({ n: expect.any(Number) });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
