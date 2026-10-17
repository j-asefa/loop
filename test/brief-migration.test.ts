import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each([92, 93, 94])(
  "preserves brief records and restarts after unrecorded migration %i",
  (lastApplied) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-brief-migration-"));
    try {
      const seed = new Database(join(dir, "loop.db"));
      try {
        for (const file of readdirSync("migrations")
          .filter((name) => name.endsWith(".sql"))
          .sort()) {
          if (Number(file.split("-")[0]) <= lastApplied)
            seed.exec(readFileSync(join("migrations", file), "utf8"));
        }
        // The original 93/94 scripts applied their schema but omitted receipts.
        seed.exec("DELETE FROM schema_version WHERE version IN (93,94)");
        seed.exec(`
          INSERT INTO folders(id,owner_id,kind,name,created_at)
            VALUES('project','owner','project','Project',0);
          INSERT INTO brief_items(id,owner_id,project_id,kind,text,status,
            author,pinned,first_version,last_version,created_at,updated_at)
            VALUES('brief','owner','project','state','Keep owner wording',
              'active','owner',1,1,1,0,0);
        `);
        if (lastApplied >= 93)
          seed.exec(`INSERT INTO brief_generation_usage VALUES(
            'generation','owner','project',7,'{"totalTokens":42}')`);
        if (lastApplied >= 94)
          seed.exec("UPDATE brief_items SET summary='Existing summary'");
      } finally {
        seed.close();
      }
      let firstStart: unknown;
      for (let restart = 0; restart < 2; restart++) {
        const result = JSON.parse(execFileSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", `
            const {db} = await import('./src/server/db.ts');
            console.log(JSON.stringify({
              versions: db.prepare('SELECT version,applied_at FROM schema_version WHERE version IN (93,94) ORDER BY version').all(),
              item: db.prepare('SELECT owner_id,project_id,text,pinned,summary FROM brief_items WHERE id=?').get('brief'),
              usage: db.prepare('SELECT * FROM brief_generation_usage ORDER BY generation_id').all(),
              integrity: db.pragma('integrity_check',{simple:true}),
            }));
            db.close();
          `],
          {
            env: {
              ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LOOP_"))),
              LOOP_PROFILE: "companion",
              LOOP_DATA_DIR: dir,
            },
            encoding: "utf8",
          },
        ));
        expect(result.versions.map((row: { version: number }) => row.version)).toEqual([93, 94]);
        expect(result.item).toEqual({
          owner_id: "owner", project_id: "project", text: "Keep owner wording",
          pinned: 1, summary: lastApplied >= 94 ? "Existing summary" : null,
        });
        expect(result.usage).toEqual(lastApplied >= 93 ? [{
          generation_id: "generation", owner_id: "owner", project_id: "project",
          started_at: 7, usage: '{"totalTokens":42}',
        }] : []);
        expect(result.integrity).toBe("ok");
        if (restart === 0) firstStart = result;
        else expect(result).toEqual(firstStart);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
