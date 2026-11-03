import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyMigrations } from "../src/server/migrations";
import { installFixtureProjection } from "./helpers/projected-writer";

const exec = promisify(execFile);
const owners = ["owner-one", "owner-two"];

it.each(["server", "companion"])(
  "%s marks existing Done results read once, including dismissed and grouped cards",
  async (profile) => {
    const directory = mkdtempSync(join(tmpdir(), "loop-done-read-migration-"));
    const db = new Database(join(directory, "loop.db"));
    try {
      db.pragma("foreign_keys=ON");
      const oldMigrations = join(directory, "migrations");
      mkdirSync(oldMigrations);
      for (const file of readdirSync("migrations").filter(
        (file) => file.endsWith(".sql") && Number(file.split("-")[0]) <= 136,
      ))
        copyFileSync(join("migrations", file), join(oldMigrations, file));
      applyMigrations(db, oldMigrations);
      db.prepare("INSERT INTO deployment_profile VALUES(1,?)").run(profile);
      installFixtureProjection(db);
      db.transaction(() => {
        for (const owner of owners) {
          const conversation = owner + "-thread";
          db.prepare(
            "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,1)",
          ).run(conversation, owner, "Existing results");
          for (const kind of ["result", "read", "dismissed", "pending"]) {
            const run = owner + "-" + kind;
            db.prepare(
              "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,1,2)",
            ).run(
              run,
              owner,
              conversation,
              kind,
              kind === "pending" ? "running" : "completed",
              run,
            );
            db.prepare(
              "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,2)",
            ).run(run + "-answer", owner, conversation, run, kind + " answer");
          }
          db.prepare(
            "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'assistant','Imported answer',3)",
          ).run(owner + "-imported", owner, conversation);
          db.prepare(
            "INSERT INTO done_card_reads(owner_id,conversation_id,card_key,read_at) VALUES(?,?,?,123)",
          ).run(owner, conversation, "run:" + owner + "-read");
          db.prepare(
            "INSERT INTO done_card_dismissals(owner_id,conversation_id,card_key,created_at) VALUES(?,?,?,4)",
          ).run(owner, conversation, "run:" + owner + "-dismissed");
          db.prepare(
            "INSERT INTO done_threads(id,owner_id,title,created_at) VALUES(?,?,'Saved group',5)",
          ).run(owner + "-group", owner);
          for (const kind of ["result", "dismissed"])
            db.prepare(
              "INSERT INTO done_thread_members(owner_id,card_id,thread_id,conversation_id) VALUES(?,?,?,?)",
            ).run(
              owner,
              "d:run:" + owner + "-" + kind,
              owner + "-group",
              conversation,
            );
        }
      }).immediate();
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM feed_cards WHERE kind='result' AND unread=1",
          )
          .get(),
      ).toEqual({ n: 6 });
      const sources = () =>
        [
          "conversations",
          "runs",
          "messages",
          "done_threads",
          "done_thread_members",
          "done_card_dismissals",
        ].map((table) =>
          db.prepare("SELECT * FROM " + table + " ORDER BY owner_id").all(),
        );
      const before = sources();
      expect(before[0]).toEqual(
        owners.map((owner) =>
          expect.objectContaining({ owner_id: owner, origin: "loop" }),
        ),
      );
      const start = async () => {
        const { stdout } = await exec(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
          const { db } = await import('./src/server/db.ts');
          const { feed } = await import('./src/server/mobile-return.ts');
          const { doneCards } = await import('./src/server/done-cards.ts');
          const { listDoneThreads } = await import('./src/server/done-threads.ts');
          const result = ${JSON.stringify(owners)}.map(owner => ({
            owner,
            unread: feed(owner, { filter: 'done', expand: 'results' }).summary.done_unread,
            cards: Object.fromEntries(doneCards(owner, { folders: null, teamIds: [], limit: 50,
              ids: db.prepare("SELECT 'd:'||card_key id FROM feed_cards WHERE owner_id=? AND kind='result'").all(owner).map(row => row.id),
              includeDismissed: true,
            }).map(({ card }) => [card.id, card.display.read_at])),
            groups: listDoneThreads(owner, {}).map(group => group.unread),
          }));
          console.log(JSON.stringify(result));
          db.close();
          `,
          ],
          {
            env: {
              ...process.env,
              LOOP_DATA_DIR: directory,
              LOOP_PROFILE: profile,
            },
            timeout: 15000,
          },
        );
        return JSON.parse(stdout);
      };
      const migratedAt = Date.now();
      const first = await start();
      expect(first).toHaveLength(2);
      for (const [index, owner] of owners.entries()) {
        expect(first[index]).toMatchObject({ owner, unread: 0, groups: [0] });
        expect(first[index].cards).toEqual({
          ["d:run:" + owner + "-read"]: 123,
          ["d:run:" + owner + "-result"]: expect.any(Number),
          ["d:run:" + owner + "-dismissed"]: expect.any(Number),
          ["d:message:" + owner + "-imported"]: expect.any(Number),
        });
        expect(
          first[index].cards["d:run:" + owner + "-result"],
        ).toBeGreaterThanOrEqual(migratedAt);
      }
      // The later name migration updates only these conversation origins.
      // Every other source field must survive the full production upgrade.
      expect(sources()).toEqual([
        before[0].map((row) => ({
          ...(row as Record<string, unknown>),
          origin: "loop",
        })),
        ...before.slice(1),
      ]);
      expect(
        db.prepare("SELECT count(*) n FROM feed_card_dirty").get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM feed_cards WHERE kind='result' AND unread=1",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT count(*) n FROM done_card_reads").get(),
      ).toEqual({ n: 8 });
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM done_card_reads d JOIN conversations c ON c.id=d.conversation_id WHERE d.owner_id<>c.owner_id",
          )
          .get(),
      ).toEqual({ n: 0 });

      // A run already working at migration time and a newly imported answer
      // become unread results. Restarting must not apply the reset again.
      db.transaction(() => {
        db.prepare(
          "UPDATE runs SET state='completed',updated_at=6 WHERE id='owner-one-pending'",
        ).run();
        db.prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('new-import','owner-one','owner-one-thread','assistant','New answer',7)",
        ).run();
      }).immediate();
      const second = await start();
      expect(second[0]).toEqual({
        ...first[0],
        unread: 2,
        cards: {
          ...first[0].cards,
          "d:run:owner-one-pending": null,
          "d:message:new-import": null,
        },
      });
      expect(second[1]).toEqual(first[1]);
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM schema_migrations WHERE name='mark-existing-done-cards-read'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
