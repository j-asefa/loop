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

function sqlCallLines(file: string, text: string, includePragmas = false) {
  const { program, errors } = parseSync(file, text);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  type Binding = "connection" | "inferred" | "constructor" | "other";
  type Scope = { parent?: Scope; bindings: Map<string, Binding> };
  const nodes: any[] = [];
  const scopes = new Map<object, Scope>();
  const scopeKinds = new Set([
    "BlockStatement",
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "CatchClause",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "SwitchStatement",
  ]);
  const fileScope: Scope = { bindings: new Map() };
  const visit = (node: any, parent: Scope): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, parent));
      return;
    }
    const scope: Scope = scopeKinds.has(node.type)
      ? { parent, bindings: new Map() }
      : parent;
    if (node.type) {
      nodes.push(node);
      scopes.set(node, scope);
    }
    for (const value of Object.values(node)) visit(value, scope);
  };
  visit(program, fileScope);
  const scopeOf = (node: any) => scopes.get(node) ?? fileScope;
  const declaringScope = (name: string, node: any): Scope | undefined => {
    for (
      let scope: Scope | undefined = scopeOf(node);
      scope;
      scope = scope.parent
    )
      if (scope.bindings.has(name)) return scope;
    return undefined;
  };
  const bindingOf = (name: string, node: any) =>
    declaringScope(name, node)?.bindings.get(name);
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
  const unwrap = (node: any) => {
    while (
      node?.type === "AwaitExpression" ||
      node?.type === "ParenthesizedExpression"
    )
      node = node.type === "AwaitExpression" ? node.argument : node.expression;
    return node;
  };
  const importsSqlite = (node: any) => {
    const expression = unwrap(node);
    return (
      expression?.type === "ImportExpression" &&
      expression.source.value === "better-sqlite3"
    );
  };
  const bindings = (pattern: any) => {
    if (pattern.type === "AssignmentPattern") pattern = pattern.left;
    if (pattern.type === "Identifier") return [{ name: pattern.name, key: "" }];
    if (pattern.type !== "ObjectPattern") return [];
    return pattern.properties.flatMap((member: any) => {
      if (member.type !== "Property") return [];
      const binding =
        member.value.type === "AssignmentPattern"
          ? member.value.left
          : member.value;
      const key =
        member.key.type === "Literal"
          ? member.key.value
          : member.computed
            ? undefined
            : member.key.name;
      return binding.type === "Identifier" && typeof key === "string"
        ? [{ key, name: binding.name }]
        : [];
    });
  };
  for (const node of nodes) {
    const scope = scopeOf(node);
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        let binding: Binding = "other";
        if (
          node.source.value === "better-sqlite3" &&
          specifier.type === "ImportDefaultSpecifier"
        )
          binding = "constructor";
        if (
          specifier.imported?.name === "db" &&
          /(?:^|\/)db(?:\.js)?$/.test(node.source.value)
        )
          binding = "connection";
        scope.bindings.set(specifier.local.name, binding);
      }
    }
    if (node.type === "VariableDeclarator") {
      const value = unwrap(node.init);
      const sqliteConstructor =
        (value?.type === "MemberExpression" &&
          property(value) === "default" &&
          importsSqlite(value.object)) ||
        (value?.type === "CallExpression" &&
          value.callee.name === "require" &&
          value.arguments[0]?.value === "better-sqlite3");
      for (const { key, name } of bindings(node.id)) {
        let binding: Binding = "other";
        if (key === "db") binding = "connection";
        if (
          (key === "default" && importsSqlite(node.init)) ||
          (key === "" && sqliteConstructor)
        )
          binding = "constructor";
        scope.bindings.set(name, binding);
      }
    }
    const parameters =
      node.params ??
      (node.type === "CatchClause" && node.param ? [node.param] : []);
    for (const parameter of parameters) {
      for (const { key, name } of bindings(parameter)) {
        const binding =
          key === "db"
            ? "connection"
            : key === "" && name === "database"
              ? "inferred"
              : "other";
        scope.bindings.set(name, binding);
      }
    }
  }
  const connectionKind = (node: any) => {
    const name = receiver(node);
    if (!name) return undefined;
    if (name === "db" || name.endsWith(".db")) return "connection";
    const binding = bindingOf(name, node);
    return binding === "connection" || binding === "inferred"
      ? binding
      : undefined;
  };
  const isConstructor = (name: string, node: any) =>
    bindingOf(name, node) === "constructor";
  // Explicitly typed SQLite parameters also cover dynamic SQL statements.
  for (const node of nodes) {
    const type = node.typeAnnotation?.typeAnnotation?.typeName;
    const databaseType =
      type?.type === "TSQualifiedName"
        ? type.right?.name === "Database" &&
          isConstructor(type.left?.name, node)
        : isConstructor(type?.name, node);
    if (node.type === "Identifier" && databaseType)
      scopeOf(node).bindings.set(node.name, "connection");
  }
  // Resolve aliases in their own bindings and preserve weaker inference for
  // untyped parameters as it passes through an alias.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!["VariableDeclarator", "AssignmentExpression"].includes(node.type))
        continue;
      const declaration = node.type === "VariableDeclarator";
      const target = receiver(declaration ? node.id : node.left);
      const value = unwrap(declaration ? node.init : node.right);
      if (!target) continue;
      const binding =
        connectionKind(value) ??
        (value?.type === "NewExpression" &&
        isConstructor(value.callee.name, value)
          ? "connection"
          : undefined);
      if (!binding) continue;
      const owner = declaration
        ? scopeOf(node)
        : (declaringScope(target, node) ?? scopeOf(node));
      const previous = owner.bindings.get(target);
      if (previous === binding || previous === "connection") continue;
      owner.bindings.set(target, binding);
      changed = true;
    }
  }
  const methods = new Set(["prepare", "exec"]);
  if (includePragmas) methods.add("pragma");
  return nodes
    .filter((node) => {
      if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression"
      )
        return false;
      const method = property(node.callee);
      if (!methods.has(method)) return false;
      const binding = connectionKind(node.callee.object);
      if (binding === "connection") return true;
      if (binding !== "inferred") return false;
      // A name-derived parameter needs evidence of a SQL statement so an
      // unrelated adapter can still use exec or prepare in the same file.
      const statement = node.arguments[0];
      const text =
        statement?.type === "TemplateLiteral"
          ? statement.quasis[0]?.value.cooked
          : statement?.value;
      return (
        typeof text === "string" &&
        (method === "pragma" ||
          /^\s*(?:SELECT|WITH|INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|REINDEX|ANALYZE|EXPLAIN)\b/i.test(
            text,
          ))
      );
    })
    .map((node) => text.slice(0, node.start).split("\n").length);
}
const inventory = (file: string, text: string) =>
  sqlCallLines(file, text).length;

// Failure text names the rule, the repository's pattern and its recipe.
const sqlRecipe =
  "docs/architecture.md#recipe-add-or-extend-a-sql-table-module";
const directSql = (location: string) =>
  `${location} calls SQLite directly. Put the query in the module under src/server/sql/ that owns its table and call that (${sqlRecipe}). If this can't be satisfied, say so in the PR; do not add the file to the allowance.`;

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

it("detects renamed fixture handles and JavaScript SQLite constructors", () => {
  expect(
    sqlCallLines(
      "probe.mjs",
      `
      const { "db": fixtureConnection = fallback } = fixture;
      const { default: OpenDatabase } = await import("better-sqlite3");
      const source = new OpenDatabase(":memory:");
      fixtureConnection.prepare("SELECT 1");
      source.exec("BEGIN"); source.prepare("SELECT 2");
      function injected(database) { database.prepare("SELECT 3"); }
      function withFixture({ db: handle }) { handle.exec("SELECT 4"); }
      const Sqlite = (await import("better-sqlite3")).default;
      const scratch = new Sqlite(":memory:");
      scratch.exec("SELECT 5");
      const database = service.adapter; database.exec(command);
      function unrelated(database) { database.exec(command); }
      const { service: client } = fixture; client.prepare({});
    `,
    ),
  ).toEqual([5, 6, 6, 7, 8, 11]);
  expect(
    inventory(
      "probe.cjs",
      `
      const Sqlite = require("better-sqlite3");
      const scratch = new Sqlite(":memory:");
      scratch.exec("SELECT 5");
    `,
    ),
  ).toBe(1);
});

it("checks script pragmas and keeps SQLite alias inference in scope", () => {
  const text = `
    function fromFixture(fixture) {
      const { db: client } = fixture;
      client.pragma("foreign_keys = ON");
      {
        const client = service;
        client.prepare(options);
      }
    }
    function fromParameter(database) {
      const handle = database, alias = handle;
      alias.prepare("SELECT 1");
      handle.pragma("query_only");
    }
    function unrelated(client, handle) {
      client.prepare(options);
      handle.exec(command);
    }
    db.pragma("foreign_keys = OFF");
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 12, 13, 19]);
  expect(sqlCallLines("probe.mjs", text)).toEqual([12]);
});

it("names the line and the SQL recipe for a direct call", () => {
  const text = 'import { db } from "./db.js";\n\ndb.prepare("SELECT 1");\n';
  expect(sqlCallLines("probe.ts", text)).toEqual([3]);
  expect(directSql("src/server/probe.ts:3")).toBe(
    "src/server/probe.ts:3 calls SQLite directly. Put the query in the module under src/server/sql/ that owns its table and call that (docs/architecture.md#recipe-add-or-extend-a-sql-table-module). If this can't be satisfied, say so in the PR; do not add the file to the allowance.",
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
    const [line] = sqlCallLines(file, readFileSync(file, "utf8"), true);
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
