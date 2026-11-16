import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sqlIndex } from "../scripts/sql-index.mjs";

const repo = resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("lists exported query functions per module in a stable order", () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-sql-index-"));
  roots.push(directory);
  writeFileSync(
    join(directory, "b-table.ts"),
    [
      "/** Reads one row. Returns undefined when absent. */",
      "export function byId(db: Database, owner: string, id: string) {}",
      "function hidden(db: Database) {}",
      "export const list = (db: Database, limit = 10, ...ids: string[]) => [];",
      "export const NAME = 'b';",
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "a-table.ts"),
    "export function upsert(db: Database, { id }: Row, flag?: number) {}\n",
  );
  writeFileSync(
    join(directory, "rows.ts"),
    "export type Row = { id: string };\n",
  );
  writeFileSync(join(directory, "notes.md"), "not a module\n");
  const { text, missing } = sqlIndex(directory, "../sql");
  expect(text.split("\n").slice(4)).toEqual([
    "## [a-table.ts](../sql/a-table.ts)",
    "",
    "- `upsert(db, {…}, flag?)`",
    "",
    "## [b-table.ts](../sql/b-table.ts)",
    "",
    "- `byId(db, owner, id)` — Reads one row.",
    "- `list(db, limit?, ...ids)`",
    "",
  ]);
  expect(missing).toBe(2);
});

it("keeps docs/sql-index.md current with src/server/sql", () => {
  const { text } = sqlIndex(join(repo, "src/server/sql"));
  expect(readFileSync(join(repo, "docs/sql-index.md"), "utf8")).toBe(text);
});

it("fails --check when the index is stale", () => {
  const copy = mkdtempSync(join(tmpdir(), "loop-sql-index-check-"));
  roots.push(copy);
  mkdirSync(join(copy, "scripts"));
  mkdirSync(join(copy, "docs"));
  mkdirSync(join(copy, "src/server/sql"), { recursive: true });
  writeFileSync(
    join(copy, "scripts/sql-index.mjs"),
    readFileSync(join(repo, "scripts/sql-index.mjs")),
  );
  writeFileSync(
    join(copy, "src/server/sql/t.ts"),
    "export function read(db: Database) {}\n",
  );
  writeFileSync(join(copy, "docs/sql-index.md"), "stale\n");
  symlinkSync(join(repo, "node_modules"), join(copy, "node_modules"));
  const run = () =>
    execFileSync(
      process.execPath,
      [join(copy, "scripts/sql-index.mjs"), "--check"],
      {
        cwd: repo,
        stdio: "pipe",
      },
    );
  expect(run).toThrow(/docs\/sql-index\.md is stale: run npm run sql-index/);
  execFileSync(process.execPath, [join(copy, "scripts/sql-index.mjs")], {
    cwd: repo,
    stdio: "pipe",
  });
  expect(run().toString()).toContain("SQL index matches src/server/sql");
});
