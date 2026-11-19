import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const files = (
  directory: string,
  accepts: (path: string) => boolean = (path) => path.endsWith(".ts"),
): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path, accepts)
      : accepts(path)
        ? [path]
        : [];
  });

// These infrastructure layers own bootstrap or projection SQL, not domain queries.
const exemptions = new Map([
  [
    "execution-ownership.ts",
    "Owns the separate process-ownership lock database.",
  ],
  ["migrations.ts", "Runs immutable, point-in-time schema migrations."],
  [
    "projected-database.ts",
    "Wraps statements to preserve synchronous projection transactions.",
  ],
  ["changes.ts", "Owns the durable change-log transport."],
  [
    "change-deadlines.ts",
    "Maintains durable deadline obligations and publication.",
  ],
  ["event-subjects.ts", "Resolves change subjects inside the write boundary."],
  [
    "feed-projector.ts",
    "Maintains feed projections inside the triggering transaction.",
  ],
  [
    "feed-card-source.ts",
    "Selects the projector's source rows inside that transaction.",
  ],
]);

// Named files still being migrated. Only remove entries as their final direct
// call moves into sql/. Existing files can evolve without call-count churn;
// new files must use query modules and fully migrated files cannot regress.
const allowance: string[] = [];

// Existing smoke and diagnostic callers of SQLite. Remove an entry once its
// last direct call moves to an existing writer or query module.
const scriptAllowance = [
  "acp-deterministic-browser.mjs",
  "approval-layout-browser.mjs",
  "cards-browser-smoke.mjs",
  "cards-content-browser.mjs",
  "companion-browser-smoke.mjs",
  "conversation-history-smoke.mjs",
  "design-scenario.mjs",
  "display-browser-smoke.mjs",
  "feed-transfer-smoke.mjs",
  "feed-websocket-smoke.mjs",
  "fleet-acceptance.mjs",
  "helpers/agent-mail-smoke.mjs",
  "helpers/agent-thread-feed-smoke.mjs",
  "helpers/artifact-read-abort-smoke.mjs",
  "helpers/beginner-chat-smoke.mjs",
  "helpers/card-reminders-smoke.mjs",
  "helpers/checkout-fixture.mjs",
  "helpers/companion-contracts-browser.mjs",
  "helpers/composer-typing-smoke.mjs",
  "helpers/continuation-smoke.mjs",
  "helpers/continuity-smoke.mjs",
  "helpers/conversation-live-smoke.mjs",
  "helpers/create-agent-layout-smoke.mjs",
  "helpers/create-agent-models-smoke.mjs",
  "helpers/design-fixture.mjs",
  "helpers/done-card-actions-smoke.mjs",
  "helpers/done-card-dismissal-smoke.mjs",
  "helpers/done-feed-filters-smoke.mjs",
  "helpers/execution-environments-smoke.mjs",
  "helpers/feed-flows-smoke.mjs",
  "helpers/feed-loading-smoke.mjs",
  "helpers/feed-reading-smoke.mjs",
  "helpers/feed-threads-smoke.mjs",
  "helpers/fleet-browser-host.mjs",
  "helpers/html-preview-smoke.mjs",
  "helpers/markdown-definitions-smoke.mjs",
  "helpers/model-labels-smoke.mjs",
  "helpers/native-auth-browser.mjs",
  "helpers/native-settings-browser.mjs",
  "helpers/needs-stack-smoke.mjs",
  "helpers/personal-decisions-smoke.mjs",
  "helpers/profile-navigation-smoke.mjs",
  "helpers/profile-work-smoke.mjs",
  "helpers/quoted-reply-fixture.mjs",
  "helpers/reply-keyboard-smoke.mjs",
  "helpers/result-files-smoke.mjs",
  "helpers/search-categories-smoke.mjs",
  "helpers/social-smoke.mjs",
  "helpers/steering-replies-smoke.mjs",
  "helpers/swipe-back-smoke.mjs",
  "helpers/team-directory-smoke.mjs",
  "helpers/team-feed-visibility-smoke.mjs",
  "helpers/team-presets-smoke.mjs",
  "helpers/thread-layout-smoke.mjs",
  "helpers/visual-layout-smoke.mjs",
  "helpers/webhook-settings-smoke.mjs",
  "helpers/withdraw-draft-smoke.mjs",
  "helpers/workspace-controls-smoke.mjs",
  "math-browser-smoke.mjs",
  "memory-recall-eval.ts",
  "native-decision-recovery-browser.mjs",
  "personal-files-events-smoke.mjs",
  "pull-requests-smoke.mjs",
  "readme-screenshots.mjs",
  "workspace-lifecycle-smoke.mjs",
];

function sqlCallLines(file: string, text: string) {
  const { program, errors } = parseSync(file, text);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const nodes: any[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type) nodes.push(node);
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  const property = (node: any) =>
    node?.computed ? node.property?.value : node?.property?.name;
  const receiver = (node: any): string | undefined => {
    if (node?.type === "Identifier") return node.name;
    if (node?.type === "ThisExpression") return "this";
    if (node?.type === "MemberExpression") {
      const base = receiver(node.object),
        key = property(node);
      return base && typeof key === "string" ? `${base}.${key}` : undefined;
    }
    return undefined;
  };
  const connections = new Set(["db"]);
  const constructors = new Set<string>();
  for (const node of nodes) {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        if (
          node.source.value === "better-sqlite3" &&
          specifier.type === "ImportDefaultSpecifier"
        )
          constructors.add(specifier.local.name);
        if (
          specifier.imported?.name === "db" &&
          /(?:^|\/)db(?:\.js)?$/.test(node.source.value)
        )
          connections.add(specifier.local.name);
      }
    }
  }
  const isConnection = (node: any) => {
    const name = receiver(node);
    return (
      name !== undefined && (connections.has(name) || name.endsWith(".db"))
    );
  };
  // Typed injected connections may execute SQL without a prepare call in this
  // file. Include them even when their parameter name is not "db".
  for (const node of nodes) {
    const type = node.typeAnnotation?.typeAnnotation;
    const name = type?.typeName;
    const databaseType =
      name?.type === "TSQualifiedName"
        ? constructors.has(name.left?.name) && name.right?.name === "Database"
        : constructors.has(name?.name);
    if (node.type === "Identifier" && databaseType) connections.add(node.name);
  }
  // Track local aliases, including aliases of aliases, and separately opened
  // SQLite connections (for example the execution-ownership lock database).
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const target =
        node.type === "VariableDeclarator"
          ? receiver(node.id)
          : node.type === "AssignmentExpression"
            ? receiver(node.left)
            : undefined;
      const value = node.type === "VariableDeclarator" ? node.init : node.right;
      if (
        target &&
        !connections.has(target) &&
        (isConnection(value) ||
          (value?.type === "NewExpression" &&
            constructors.has(value.callee.name)))
      ) {
        connections.add(target);
        changed = true;
      }
    }
  }
  return nodes
    .filter(
      (node) =>
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        ["prepare", "exec"].includes(property(node.callee)) &&
        isConnection(node.callee.object),
    )
    .map((node) => text.slice(0, node.start).split("\n").length);
}
const inventory = (file: string, text: string) =>
  sqlCallLines(file, text).length;

// Failure text names the rule, the repository's pattern and its recipe.
const sqlRecipe =
  "docs/architecture.md#recipe-add-or-extend-a-sql-table-module";
const directSql = (location: string) =>
  `${location} calls prepare or exec on a database connection. Put the query in the module under src/server/sql/ that owns its table and call that (${sqlRecipe}). If this can't be satisfied, say so in the PR; do not add the file to the allowance.`;

it("counts SQL calls and aliases without counting comments, strings or regular expressions", () => {
  expect(
    inventory(
      "probe.ts",
      `
    import { db as connection } from "./db.js";
    import SQLite from "better-sqlite3";
    const alias = connection, second = alias;
    const lock = new SQLite(":memory:");
    connection.prepare("SELECT 1"); second["exec"]("SELECT 2");
    lock.exec("BEGIN"); db?.prepare("SELECT 3");
    api.prepare("not SQL"); destination.prepare({}); policy.prepare?.();
    this.db.prepare(query);
    function injected(database: SQLite.Database) { database.exec("SELECT 4"); }
    // db.prepare("ignored")
    const text = 'db.exec("ignored")'; /db.prepare/.exec(text);
  `,
    ),
  ).toBe(6);
});

it("names the line and the SQL recipe for a direct call", () => {
  const text = 'import { db } from "./db.js";\n\ndb.prepare("SELECT 1");\n';
  expect(sqlCallLines("probe.ts", text)).toEqual([3]);
  expect(directSql("src/server/probe.ts:3")).toBe(
    "src/server/probe.ts:3 calls prepare or exec on a database connection. Put the query in the module under src/server/sql/ that owns its table and call that (docs/architecture.md#recipe-add-or-extend-a-sql-table-module). If this can't be satisfied, say so in the PR; do not add the file to the allowance.",
  );
});

it("keeps direct SQL in the shrinking named file allowance", () => {
  const actual = new Map<string, string>();
  const serverFiles = files(join(root, "src/server"));
  const hostFiles = readdirSync(join(root, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(root, "src", name));
  for (const file of [...serverFiles, ...hostFiles].sort()) {
    const path = relative(join(root, "src/server"), file);
    if (path.startsWith("sql/") || exemptions.has(path)) continue;
    const lines = sqlCallLines(file, readFileSync(file, "utf8"));
    if (lines.length) actual.set(path, `${relative(root, file)}:${lines[0]}`);
  }
  const allowed = new Set(allowance);
  expect(allowed.size, "Duplicate allowance entries").toBe(allowance.length);
  expect(
    [...actual]
      .filter(([path]) => !allowed.has(path))
      .map(([, location]) => directSql(location)),
    "New or fully migrated files must put SQL in src/server/sql/",
  ).toEqual([]);
  expect(
    allowance
      .filter((path) => !actual.has(path))
      .map(
        (path) =>
          `src/server/${path} has no direct SQL left; remove it from the allowance in test/sql-inventory.test.ts.`,
      ),
    "Remove files from the allowance when their last direct call moves",
  ).toEqual([]);
});

it("keeps direct script SQL in the shrinking named file allowance", () => {
  const directory = join(root, "scripts");
  const actual = new Map<string, string>();
  for (const file of files(directory, (path) =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path),
  ).sort()) {
    const [line] = sqlCallLines(file, readFileSync(file, "utf8"));
    if (line !== undefined)
      actual.set(relative(directory, file), `${relative(root, file)}:${line}`);
  }
  const allowed = new Set(scriptAllowance);
  expect(allowed.size, "Duplicate script allowance entries").toBe(
    scriptAllowance.length,
  );
  expect(
    [...actual]
      .filter(([path]) => !allowed.has(path))
      .map(([, location]) => directSql(location)),
    "Script fixtures must use existing writers or query modules for new SQL callers",
  ).toEqual([]);
  expect(
    scriptAllowance
      .filter((path) => !actual.has(path))
      .map(
        (path) =>
          `scripts/${path} has no direct SQL left; remove it from the script allowance.`,
      ),
    "Remove script files from the allowance when their last direct call moves",
  ).toEqual([]);
});
