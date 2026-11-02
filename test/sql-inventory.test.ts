import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });

// These infrastructure layers own bootstrap or projection SQL, not domain queries.
const exemptions = new Map([
  ["db.ts", "Initializes the connection and installs the projection boundary."],
  ["auth.ts", "Owns a separate better-auth database, not workspace tables."],
  [
    "execution-ownership.ts",
    "Owns the separate process-ownership lock database.",
  ],
  ["migrations.ts", "Runs immutable, point-in-time schema migrations."],
  [
    "legacy-migrations.ts",
    "Bootstraps the historical migration ledger; migrations stay independent.",
  ],
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
  [
    "feed-projection.ts",
    "Defines projection storage and its invalidation contract.",
  ],
]);

// Named files still being migrated. Only remove entries as their final direct
// call moves into sql/. Existing files can evolve without call-count churn;
// new files must use query modules and fully migrated files cannot regress.
const allowance = [
  "agent-mail-policy.ts",
  "agent-mail.ts",
  "card-attachments.ts",
  "card-tokens.ts",
  "cards.ts",
  "code-reviews.ts",
  "companion-routes.ts",
  "conversation-continuations.ts",
  "conversation-pulls.ts",
  "deployments.ts",
  "design-preview.ts",
  "done-threads.ts",
  "execution-authority.ts",
  "execution-commands.ts",
  "execution-runtime-actions.ts",
  "feed-card-details.ts",
  "feed-card-read.ts",
  "feed-digests.ts",
  "feed-sources.ts",
  "feed-watches.ts",
  "filing.ts",
  "github-api.ts",
  "imports.ts",
  "index.ts",
  "local-harnesses.ts",
  "mcp/approval-policy.ts",
  "mcp/broker.ts",
  "mcp/catalog.ts",
  "mcp/client.ts",
  "mcp/credentials.ts",
  "mcp/federation.ts",
  "mcp/install.ts",
  "mcp/reverse.ts",
  "mcp/routes.ts",
  "mcp/tool-budget.ts",
  "memory.ts",
  "migration.ts",
  "native-history.ts",
  "native-providers.ts",
  "native-tool-bridge.ts",
  "native/decisions.ts",
  "native/pi-customization.ts",
  "native/projector.ts",
  "native/projects.ts",
  "native/supervisor.ts",
  "news.ts",
  "notifications.ts",
  "personal-decisions.ts",
  "personal-files.ts",
  "pr-watches.ts",
  "published-files.ts",
  "queue.ts",
  "review-access.ts",
  "run-attention.ts",
  "run-checkouts.ts",
  "run-signal.ts",
  "run-verifications.ts",
  "runtime-hosts.ts",
  "search.ts",
  "sharing.ts",
  "steering.ts",
  "subscriptions.ts",
  "team-eligibility.ts",
  "token-events.ts",
  "token-requests.ts",
  "token-write-policies.ts",
  "traces.ts",
  "uploads.ts",
  "user-profile.ts",
  "webhook-outbox.ts",
  "webhooks.ts",
  "worker.ts",
  "workflows/routes.ts",
  "workflows/runtime.ts",
  "workspace-cleanup.ts",
  "workspace-events.ts",
  "workspace-project.ts",
  "workspace-routes.ts",
];

function inventory(file: string, text: string) {
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
  return nodes.filter(
    (node) =>
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      ["prepare", "exec"].includes(property(node.callee)) &&
      isConnection(node.callee.object),
  ).length;
}

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

it("keeps direct SQL in the shrinking named file allowance", () => {
  const actual = new Set<string>();
  for (const file of files(join(root, "src/server")).sort()) {
    const path = relative(join(root, "src/server"), file);
    if (path.startsWith("sql/") || exemptions.has(path)) continue;
    if (inventory(file, readFileSync(file, "utf8"))) actual.add(path);
  }
  const allowed = new Set(allowance);
  expect(allowed.size, "Duplicate allowance entries").toBe(allowance.length);
  expect(
    [...actual].filter((path) => !allowed.has(path)),
    "New or fully migrated files must put SQL in src/server/sql/",
  ).toEqual([]);
  expect(
    allowance.filter((path) => !actual.has(path)),
    "Remove files from the allowance when their last direct call moves",
  ).toEqual([]);
});
