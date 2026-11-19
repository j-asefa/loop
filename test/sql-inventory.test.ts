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

function sqlCallLines(file: string, text: string, script = false) {
  const { program, errors } = parseSync(file, text);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  type Binding = "connection" | "inferred" | "constructor" | "object" | "other";
  type Boundary = "function" | "receiver";
  type Scope = {
    parent?: Scope;
    boundary?: Boundary;
    bindings: Map<string, Binding>;
    parameters?: Set<string>;
    classes?: Map<string, Scope>;
  };
  const nodes: any[] = [];
  const scopes = new Map<object, Scope>();
  const parents = new Map<object, any>();
  const declarationScopes = new Map<object, Scope>();
  const varDeclarations = new Set<object>();
  const functionKinds = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);
  const classKinds = new Set(["ClassDeclaration", "ClassExpression"]);
  const objectMethod = (node: any) =>
    node?.type === "Property" && node.value?.type === "FunctionExpression";
  const scopeKinds = new Set([
    "BlockStatement",
    "CatchClause",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "SwitchStatement",
  ]);
  const fileScope: Scope = { bindings: new Map() };
  const visit = (node: any, parent: Scope, syntaxParent?: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, parent, syntaxParent));
      return;
    }
    const boundary = functionKinds.has(node.type)
      ? "function"
      : classKinds.has(node.type) ||
          (node.type === "ObjectExpression" &&
            node.properties.some(objectMethod))
        ? "receiver"
        : undefined;
    const scope: Scope =
      boundary || scopeKinds.has(node.type)
        ? { parent, boundary, bindings: new Map() }
        : parent;
    if (node.type === "VariableDeclaration" && node.kind === "var")
      for (const declaration of node.declarations)
        varDeclarations.add(declaration);
    if (node.type) {
      nodes.push(node);
      scopes.set(node, scope);
      parents.set(node, syntaxParent);
    }
    for (const value of Object.values(node))
      visit(value, scope, node.type ? node : syntaxParent);
  };
  visit(program, fileScope);
  const scopeOf = (node: any) => scopes.get(node) ?? fileScope;
  const boundaryScope = (node: any, boundary: Boundary) => {
    for (
      let scope: Scope | undefined = scopeOf(node);
      scope;
      scope = scope.parent
    )
      if (scope.boundary === boundary) return scope;
    return undefined;
  };
  const declarationScope = (node: any) =>
    varDeclarations.has(node)
      ? (boundaryScope(node, "function") ?? fileScope)
      : scopeOf(node);
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
  const receiverClass = new Map<Scope, any>();
  const thisScope = (node: any): Scope | undefined => {
    for (let cursor = node; cursor; cursor = parents.get(cursor)) {
      if (classKinds.has(cursor.type)) return scopeOf(cursor);
      if (
        !functionKinds.has(cursor.type) ||
        cursor.type === "ArrowFunctionExpression"
      )
        continue;
      const parent = parents.get(cursor);
      if (parent?.type === "MethodDefinition" || objectMethod(parent))
        return boundaryScope(parent, "receiver");
      return undefined;
    }
    return undefined;
  };
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
  const bindings = (pattern: any): { key: string; name: string }[] => {
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
  const dbModule = /(?:^|\/)db(?:\.js)?$/;
  const isParameter = (node: any) =>
    node?.type === "Identifier" &&
    declaringScope(node.name, node)?.parameters?.has(node.name);
  const destructuredDatabase = (source: any): Binding => {
    const path = receiver(source);
    const owner = path && declaringScope(path.split(".")[0], source);
    const property = owner ? owner.bindings.get(`${path}.db`) : undefined;
    if (property === "connection" || property === "object") return property;
    if (
      (source?.type === "ImportExpression" &&
        dbModule.test(source.source.value)) ||
      (script && (source?.name === "fixture" || isParameter(source)))
    )
      return "connection";
    return "inferred";
  };
  const recordObject = (scope: Scope, name: string, value: any): void => {
    scope.bindings.set(name, "object");
    for (const member of value.properties) {
      if (member.type !== "Property") continue;
      const key = member.computed
        ? member.key.value
        : (member.key.name ?? member.key.value);
      const child = unwrap(member.value);
      if (typeof key === "string" && child?.type === "ObjectExpression")
        recordObject(scope, `${name}.${key}`, child);
    }
  };
  for (const node of nodes) {
    const scope = declarationScope(node);
    if (classKinds.has(node.type)) {
      receiverClass.set(scope, node);
      if (node.type === "ClassDeclaration" && scope.parent && node.id)
        (scope.parent.classes ??= new Map()).set(node.id.name, scope);
    }
    if (
      node.id &&
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration")
    )
      scope.parent?.bindings.set(node.id.name, "other");
    if (
      node.id &&
      (node.type === "FunctionExpression" || node.type === "ClassExpression")
    )
      scope.bindings.set(node.id.name, "other");
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
          dbModule.test(node.source.value)
        )
          binding = "connection";
        scope.bindings.set(specifier.local.name, binding);
      }
    }
    if (node.type === "VariableDeclarator") {
      declarationScopes.set(node.id, scope);
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
        if (key === "db") binding = destructuredDatabase(value);
        if (key === "" && value?.type === "ObjectExpression") {
          recordObject(scope, name, value);
          continue;
        }
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
          key === "db" && script
            ? "connection"
            : key === "db" || (key === "" && name === "database")
              ? "inferred"
              : "other";
        scope.bindings.set(name, binding);
        if (node.params) (scope.parameters ??= new Set()).add(name);
      }
    }
  }
  const isConstructor = (name: string, node: any) =>
    bindingOf(name, node) === "constructor";
  const receiverBinding = (scope: Scope, name: string) => {
    const seen = new Set<Scope>();
    let current: Scope | undefined = scope;
    while (current && !seen.has(current)) {
      seen.add(current);
      const binding = current.bindings.get(name);
      if (binding) return binding;
      const parent: { type: string; name?: string } | undefined =
        receiverClass.get(current)?.superClass;
      current =
        parent?.type === "Identifier" && parent.name
          ? declaringScope(parent.name, parent)?.classes?.get(parent.name)
          : undefined;
    }
    return undefined;
  };
  const connectionKind = (node: any) => {
    const expression = unwrap(node);
    if (
      expression?.type === "NewExpression" &&
      isConstructor(expression.callee.name, expression)
    )
      return "connection";
    const name = receiver(expression);
    if (!name) return undefined;
    const [root] = name.split(".");
    const owner =
      root === "this" ? thisScope(node) : declaringScope(root, node);
    const binding = owner
      ? receiverBinding(owner, name)
      : root === "this"
        ? undefined
        : bindingOf(name, node);
    if (name === "db" || name.endsWith(".db")) {
      if (!script || !owner) return "connection";
      if (!binding || binding === "other") return "inferred";
    }
    return binding;
  };
  // Explicitly typed SQLite parameters also cover dynamic SQL statements.
  for (const node of nodes) {
    const type = node.typeAnnotation?.typeAnnotation?.typeName;
    const databaseType =
      type?.type === "TSQualifiedName"
        ? type.right?.name === "Database" &&
          isConstructor(type.left?.name, node)
        : isConstructor(type?.name, node);
    if (node.type === "Identifier" && databaseType)
      (declarationScopes.get(node) ?? scopeOf(node)).bindings.set(
        node.name,
        "connection",
      );
  }
  // Resolve aliases in their own bindings and preserve weaker inference for
  // untyped parameters as it passes through an alias.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const declaration = node.type === "VariableDeclarator";
      const field = node.type === "PropertyDefinition" && !node.static;
      if (!declaration && !field && node.type !== "AssignmentExpression")
        continue;
      const target = declaration ? node.id : node.left;
      const value = unwrap(
        declaration ? node.init : field ? node.value : node.right,
      );
      const assigned: { name: string; binding: Binding | undefined }[] = [];
      if (target?.type === "ObjectPattern") {
        for (const { key, name } of bindings(target))
          if (key === "db")
            assigned.push({ name, binding: destructuredDatabase(value) });
      } else if (field) {
        const key = node.computed
          ? node.key.value
          : (node.key.name ?? node.key.value);
        if (typeof key === "string")
          assigned.push({
            name: `this.${key}`,
            binding: connectionKind(value),
          });
      } else {
        const name = receiver(target);
        if (name) assigned.push({ name, binding: connectionKind(value) });
      }
      for (const { name, binding } of assigned) {
        const owner = declaration
          ? declarationScope(node)
          : name.startsWith("this.")
            ? thisScope(node)
            : (declaringScope(name.split(".")[0], node) ?? scopeOf(node));
        if (!owner) continue;
        if (target?.type === "Identifier" && isParameter(value)) {
          const parameters = (owner.parameters ??= new Set());
          if (!parameters.has(name)) {
            parameters.add(name);
            changed = true;
          }
        }
        if (!binding || binding === "other" || binding === "constructor")
          continue;
        const previous = owner.bindings.get(name);
        if (
          previous === binding ||
          previous === "connection" ||
          (previous === "object" && binding === "inferred")
        )
          continue;
        owner.bindings.set(name, binding);
        changed = true;
      }
    }
  }
  const methods = new Set(["prepare", "exec"]);
  if (script) methods.add("pragma");
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
      // Script fixtures can prepare a query held in a variable. An inferred
      // exec caller still needs a recognizable SQL statement.
      const statement = node.arguments[0];
      if (script && method === "prepare" && statement?.type === "Identifier")
        return true;
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

it("tracks hoisted aliases and instance fields without guessing adapter types", () => {
  const text = `
    function hoisted(flag) {
      if (flag) { var handle = db; }
      handle.exec(sql);
    }
    const { db: client } = adapters;
    client.exec(command);
    class Reader {
      constructor() { this.connection = db; }
      read() { this.connection.prepare(sql); }
    }
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 10]);
});

it("tracks dynamic queries, typed hoisted handles and shared object fields", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const { db: handle } = fixture;
    handle.prepare(query);
    function typed(flag) {
      if (flag) { var sql: SQLite.Database; }
      sql.exec(query);
    }
    const state = {};
    function bind() { state.connection = db; }
    function read() { state.connection.prepare(query); }
    function unrelated() {
      const state = { connection: adapter };
      state.connection.prepare(query);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([4, 7, 11]);
  expect(sqlCallLines("probe.ts", text)).toEqual([7, 11]);
});

it("counts a fixture's dynamic exec without counting a local command adapter", () => {
  const text = `
    function seed(fixture, query) {
      const { db: sqlite } = fixture;
      sqlite.exec(query);
    }
    function dispatch(command) {
      const db = { exec: runCommand };
      db.exec(command);
    }
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4]);
});

it("counts renamed parameters and inline SQLite without counting nested adapters", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function migrate({ db: handle }, statement) {
      handle.exec(statement);
    }
    new SQLite(":memory:").exec("SELECT 1");
    const services = { db: { exec: runCommand } };
    services.db.exec(command);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 6]);
});

it("keeps receiver aliases and shadowed constructors in their own scope", () => {
  const text = `
    import OpenDatabase from "better-sqlite3";
    const operations = {
      bind() { this.connection = db; },
      inspect() { this.connection.prepare(query); },
    };
    function migrate(context, query) {
      const { db: handle } = context;
      handle.exec(query);
    }
    function dispatch(command) {
      function OpenDatabase() { return { exec: runCommand }; }
      new OpenDatabase().exec(command);
    }
  `;
  expect(sqlCallLines("probe.ts", text)).toEqual([5]);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 9]);
});

it("follows inherited fields, field initializers and destructuring assignments", () => {
  const text = `
    import SQLite from "better-sqlite3";
    class Parent {
      constructor() {
        this.connection = db;
        function dispatch() { this.connection.exec(command); }
        dispatch.call(adapter);
      }
    }
    class Child extends Parent {
      read() {
        this.connection.prepare(query);
        const read = () => this.connection.prepare(query);
        function dispatch() { this.connection.exec(command); }
        dispatch.call(adapter);
      }
    }
    class Independent {
      connection = new SQLite(":memory:");
      read() { this.connection.exec(query); }
    }
    let handle;
    ({ db: handle } = fixture);
    handle.exec(query);
  `;
  expect(sqlCallLines("probe.ts", text)).toEqual([12, 13, 20]);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([12, 13, 20, 24]);
});

it("uses known property bindings and carries fixture and object aliases", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function dispatch(db, command) { db.exec(command); }
    {
      const adapter = { exec: runCommand };
      const db = adapter;
      db.exec(command);
    }
    const holder = {};
    holder.db = new SQLite(":memory:");
    const { db: handle } = holder;
    handle.exec(query);
    function seed(context, query) {
      const fixtureAlias = context;
      const { db: connection } = fixtureAlias;
      connection.exec(query);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([12, 16]);
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
