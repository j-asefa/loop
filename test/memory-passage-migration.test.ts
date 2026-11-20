import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { memoryKeys } from "../src/server/memory-keys.js";
import { memoryPassages } from "../src/server/memory-passages.js";
import { applyMigrationsThrough } from "./helpers/migrations.js";
import { createTestWorkspace } from "./helpers/test-workspace.js";

it("preserves offsets and packs paragraphs around a short fenced block", () => {
  const fence = "```ts\n" + "// code\n".repeat(300) + "```\n";
  const raw =
    "# Start\n\n" +
    "paragraph ".repeat(90) +
    "\n\n" +
    fence +
    "\n## End\n\n" +
    "😀 ".repeat(850);
  const spans = memoryPassages(raw);
  const passages = spans.map(({ start, end }) => raw.slice(start, end));
  expect(spans[0].start).toBe(0);
  expect(spans.at(-1)?.end).toBe(raw.length);
  for (let index = 1; index < spans.length; index++)
    expect(spans[index].start).toBeLessThanOrEqual(spans[index - 1].end);
  expect(passages).toContain(fence);
  expect(
    passages
      .filter((passage) => passage !== fence)
      .every((passage) => passage.length <= 1600),
  ).toBe(true);
});

it.each(["artifact", "note"])(
  "bridges a boundary before a final single-word paragraph (kind=%s)",
  (kind) => {
    const raw = "filler ".repeat(227) + "tamarind\n\nsorrel";
    const passages = memoryPassages(raw, kind).map(({ start, end }) =>
      raw.slice(start, end),
    );
    expect(
      passages.some((passage) => passage.includes("tamarind\n\nsorrel")),
    ).toBe(true);
  },
);

it("extracts structural keys and identifiers from a passage", () => {
  const raw = [
    "# Release #781",
    "**Decision:** Keep the raw excerpt.",
    "Outcome: shipped",
    "src/server/memory.ts and 67b9efd",
    "npm install zod and @scope/tool",
    'const x = require("react");',
    "https://example.com/project/run?token=private#fragment",
  ].join("\n");
  expect(memoryKeys(raw)).toEqual(
    expect.arrayContaining([
      "Release #781",
      "#781",
      "Decision",
      "Outcome: shipped",
      "src/server/memory.ts",
      "67b9efd",
      "zod",
      "react",
      "@scope/tool",
      "example.com/project/run",
    ]),
  );
  expect(memoryKeys(raw).join(" ")).not.toMatch(/private|fragment/);
});

it("upgrades captured notes and resumes a bounded backfill without interrupting search", () => {
  const workspace = createTestWorkspace();
  try {
    const old = new Database(join(workspace.directory, "loop.db"));
    old
      .transaction(() => {
        applyMigrationsThrough(old, 166);
        const add = old.prepare(`INSERT INTO memory_sources
        (id,owner_id,kind,source_id,origin,role,revision,content_hash,content,title,eligible,created_at,updated_at)
        VALUES (?,?,'note',?,'loop','user-note',1,'fixture',?,?,1,1,1)`);
        for (let index = 0; index < 105; index++) {
          const id = "a-" + String(index).padStart(3, "0");
          add.run(id, "owner", id, "filler text", "Filler");
        }
        add.run(
          "z-owner",
          "owner",
          "z-owner",
          "# Release #781\n\nsapphire revision proof",
          "Upgrade proof",
        );
        add.run(
          "z-other",
          "other",
          "z-other",
          "# Release #781\n\nsapphire revision private",
          "Upgrade proof",
        );
        old
          .prepare("INSERT INTO memory_passages VALUES (1,'z-owner',1,0,0,42)")
          .run();
        old
          .prepare(
            "INSERT INTO memory_passage_fts(rowid,source_id,owner_id,ordinal,title,body) VALUES(1,'z-owner','owner',0,'Upgrade proof','sapphire')",
          )
          .run();
        old.prepare("INSERT INTO memory_passage_backfill VALUES(1)").run();
      })
      .immediate();
    old.close();

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      const { db } = await import('./src/server/db.ts');
      const { captureMemory, searchMemory } = await import('./src/server/memory.ts');
      const passages = await import('./src/server/sql/memory-passages.ts');
      const sources = await import('./src/server/sql/memory-sources.ts');
      const recall = async () => (await searchMemory('owner', null, 'sapphire revision', { relevant: true })).sources.map(s => s.excerpt);
      const before = await recall();
      const counts = [captureMemory(), captureMemory(), captureMemory()];
      const after = await recall();
      const heading = (await searchMemory('owner', null, '#781', { relevant: true })).sources.map(s => s.excerpt);
      const keyHits = passages.search(db, 'keys:781', 'owner', null).map(s => s.id);
      sources.tombstone(db, 'a-000');
      const { default: Database } = await import('better-sqlite3');
      const maintenance = new Database(db.name);
      maintenance.exec('VACUUM');
      maintenance.close();
      const compacted = await recall();
      const saved = sources.owned(db, 'z-owner', 'owner');
      const indexed = passages.search(db, 'sapphire', 'owner', null).map(s => s.revision);
      sources.tombstone(db, 'z-owner');
      const deleted = passages.search(db, 'sapphire', 'owner', null).length;
      console.log(JSON.stringify({ before, counts, after, heading, keyHits, compacted, revision: saved.revision, indexed, deleted }));
      db.close();
    `,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, LOOP_DATA_DIR: workspace.directory },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      before: ["# Release #781\n\nsapphire revision proof"],
      counts: [100, 7, 0],
      after: ["# Release #781\n\nsapphire revision proof"],
      compacted: ["# Release #781\n\nsapphire revision proof"],
      heading: ["# Release #781\n\nsapphire revision proof"],
      keyHits: ["z-owner"],
      revision: 1,
      indexed: [1],
      deleted: 0,
    });
  } finally {
    workspace.close();
  }
});
