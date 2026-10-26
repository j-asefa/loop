import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { applyMigrations } from "../src/server/migrations";

it.each([null, 118, 123])(
  "backfills before startup returns with concurrent database users (upgrade=%s)",
  async (upgrade) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-feed-migration-"));
    const env = { ...process.env, LOOP_DATA_DIR: dir, LOOP_PROFILE: "server" };
    const source = pathToFileURL(resolve("src/server/db.ts")).href;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      if (upgrade !== null) {
        const old = new Database(join(dir, "loop.db"));
        old.pragma("foreign_keys=ON");
        old
          .transaction(() => {
            const migrationDir = join(dir, "migrations");
            mkdirSync(migrationDir);
            for (const file of readdirSync("migrations").filter(
              f => f.endsWith(".sql") && Number(f.split("-")[0]) <= upgrade,
            )) copyFileSync(join("migrations", file), join(migrationDir, file));
            applyMigrations(old, migrationDir);
            old
              .prepare("INSERT INTO deployment_profile VALUES(1,'server')")
              .run();
            old
              .prepare(
                "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c','owner','Kept thread',1)",
              )
              .run();
            old
              .prepare(
                "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('m','owner','c','assistant','Kept answer',2)",
              )
              .run();
          })
          .immediate();
        old.close();
      }
      const scripts = [
        `const {db}=await import(${JSON.stringify(source)});console.log(JSON.stringify({versions:db.prepare('SELECT name,prefix AS version FROM schema_migrations ORDER BY prefix,name').all(),dirty:db.prepare('SELECT count(*) n FROM feed_card_dirty').get(),cards:db.prepare('SELECT owner_id,conversation_id,kind,card_key FROM feed_cards ORDER BY kind').all()}));db.close();`,
        `const {db}=await import(${JSON.stringify(source)});console.log(JSON.stringify({versions:db.prepare('SELECT name,prefix AS version FROM schema_migrations ORDER BY prefix,name').all(),dirty:db.prepare('SELECT count(*) n FROM feed_card_dirty').get(),cards:db.prepare('SELECT owner_id,conversation_id,kind,card_key FROM feed_cards ORDER BY kind').all()}));db.close();`,
      ];
      const results = await Promise.all(
        scripts.map(
          (script) =>
            new Promise<string>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["--import", "tsx", "--input-type=module", "-e", script],
                { env, stdio: ["ignore", "pipe", "pipe"] },
              );
              children.push(child);
              let out = "",
                error = "";
              child.stdout.on("data", (chunk) => (out += chunk));
              child.stderr.on("data", (chunk) => (error += chunk));
              child.once("error", reject);
              child.once("exit", (code) =>
                code === 0 ? resolve(out) : reject(new Error(error)),
              );
            }),
        ),
      );
      const first = JSON.parse(results[0]),
        second = JSON.parse(results[1]);
      expect(first).toEqual(second);
      expect(first.dirty).toEqual({ n: 0 });
      expect(first.versions.filter((v: {name:string}) => v.name === "feed-card-read-switch")).toHaveLength(1);
      expect(
        first.versions.filter((v: { version: number }) => v.version === 119),
      ).toHaveLength(1);
      if (upgrade !== null)
        expect(first.cards).toEqual([
          {
            owner_id: "owner",
            conversation_id: "c",
            kind: "result",
            card_key: "message:m",
          },
          {
            owner_id: "owner",
            conversation_id: "c",
            kind: "thread",
            card_key: "message:m",
          },
        ]);
      else expect(first.cards).toEqual([]);
      const db = new Database(join(dir, "loop.db"));
      try {
        expect(db.pragma("foreign_key_check")).toEqual([]);
        if (upgrade !== null)
          expect(
            db.prepare("SELECT content FROM messages WHERE id='m'").get(),
          ).toEqual({ content: "Kept answer" });
      } finally {
        db.close();
      }
    } finally {
      children.forEach((child) => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
