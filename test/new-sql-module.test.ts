import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { check, resolveConfig } from "prettier";
import { afterEach, expect, it } from "vitest";
import {
  generateSqlModule,
  sqlModuleTemplate,
} from "../scripts/new-sql-module.mjs";

const repo = resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "loop-new-sql-module-"));
  roots.push(root);
  mkdirSync(join(root, "src/server/sql"), { recursive: true });
  mkdirSync(join(root, "docs"));
  return root;
}

it("writes a module and refreshes the index, refusing bad names and overwrites", async () => {
  const root = scratch();
  expect(await generateSqlModule(root, "saved_notes")).toBe(
    "src/server/sql/saved-notes.ts",
  );
  expect(
    readFileSync(join(root, "src/server/sql/saved-notes.ts"), "utf8"),
  ).toBe(sqlModuleTemplate("saved_notes"));
  expect(readFileSync(join(root, "docs/sql-index.md"), "utf8")).toContain(
    "- `owned(db, owner)` — Rows of saved_notes owned by `owner`.",
  );
  await expect(generateSqlModule(root, "saved_notes")).rejects.toThrow(
    /already exists; extend it instead/,
  );
  for (const name of ["Saved", "notes-x", "1notes", "../x"])
    await expect(generateSqlModule(root, name)).rejects.toThrow(
      /must be lowercase/,
    );
});

it("formats long names and removes the module when the index cannot be rebuilt", async () => {
  const root = scratch();
  const table = "a_very_long_table_name_that_pushes_the_statement_past_eighty";
  await generateSqlModule(root, table);
  const written = readFileSync(
    join(root, "src/server/sql", table.replaceAll("_", "-") + ".ts"),
    "utf8",
  );
  // The repository's formatter accepts the output unchanged.
  expect(
    await check(written, {
      ...(await resolveConfig(join(repo, "src/server/sql/statement.ts"))),
      filepath: "module.ts",
    }),
  ).toBe(true);
  writeFileSync(join(root, "src/server/sql/broken.ts"), "export function (");
  await expect(generateSqlModule(root, "saved_notes")).rejects.toThrow();
  expect(existsSync(join(root, "src/server/sql/saved-notes.ts"))).toBe(false);
});

it("keeps the template's imports and helpers in step with the canonical module", () => {
  const template = sqlModuleTemplate("mcp_preferences");
  const canonical = readFileSync(
    join(repo, "src/server/sql/mcp-preferences.ts"),
    "utf8",
  );
  const imports = (text: string) =>
    [...text.matchAll(/^import .*;$/gm)].map((match) => match[0]);
  // The scaffold starts from exactly the canonical example's imports.
  expect(imports(template)).toEqual(imports(canonical));
  for (const [, names, from] of template.matchAll(
    /^import (?:type )?\{?\s*([\w, ]+?)\s*\}? from "(\.[^"]+)";$/gm,
  )) {
    const target = join(
      repo,
      "src/server/sql",
      dirname(from),
      from.split("/").pop()!.replace(/\.js$/, ".ts"),
    );
    expect(existsSync(target), target).toBe(true);
    for (const name of names.split(",").map((part) => part.trim()))
      expect(readFileSync(target, "utf8")).toMatch(
        new RegExp(
          `export (\\{[^}]*\\b${name}\\b|(const|function) ${name}\\b)`,
        ),
      );
  }
});
