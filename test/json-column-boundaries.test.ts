import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";
import { z } from "zod";
import { MessageMetadata } from "../src/shared/message-metadata.js";
import { RunPayload } from "../src/shared/run-payload.js";
import { ArtifactMetadataSchemas } from "../src/shared/artifact-metadata.js";

const root = resolve(import.meta.dirname, "..");
const columns: Record<string, z.ZodType[]> = {
  "messages.metadata": [MessageMetadata],
  "runs.payload": [RunPayload],
  "artifacts.metadata": Object.values(ArtifactMetadataSchemas),
};
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.tsx?$/.test(path)
        ? [path]
        : [];
  });
function walk(
  node: any,
  visit: (node: any, parent?: any) => void,
  parent?: any,
) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit, parent));
    return;
  }
  if (node.type) visit(node, parent);
  for (const value of Object.values(node)) walk(value, visit, node);
}
function program(file: string, source: string) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw Error(`${file}: ${parsed.errors[0].message}`);
  return parsed.program;
}
const property = (node: any) =>
  node?.computed ? node.property?.value : node?.property?.name;
function declared(schema: z.ZodType, path: string[]): boolean {
  if (!path.length) return true;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return declared(schema.unwrap() as z.ZodType, path);
  if (schema instanceof z.ZodObject) {
    const child = schema.shape[path[0]];
    // A passthrough/catchall does not declare a SQL path.
    return !!child && declared(child, path.slice(1));
  }
  if (schema instanceof z.ZodUnion)
    return schema.options.some((arm) => declared(arm as z.ZodType, path));
  if (schema instanceof z.ZodArray && /^\d+$/.test(path[0]))
    return declared(schema.element as z.ZodType, path.slice(1));
  return false;
}

// Only literal SQL and locally composed constant strings are inspected. This is
// not a JS interpreter: runtime/imported SQL builders and computed SQL paths are
// outside this syntactic check. Unknown interpolations remain explicit markers.
function queries(ast: any): string[] {
  type Binding = { node: any; scope: Map<string, Binding> };
  function text(
    node: any,
    scope: Map<string, Binding>,
    seen = new Set<any>(),
  ): string {
    if (node?.type === "Literal" && typeof node.value === "string")
      return node.value;
    if (node?.type === "TemplateLiteral")
      return node.quasis
        .map(
          (part: any, i: number) =>
            (part.value.cooked ?? part.value.raw) +
            (i < node.expressions.length
              ? text(node.expressions[i], scope, seen)
              : ""),
        )
        .join("");
    if (node?.type === "BinaryExpression" && node.operator === "+")
      return text(node.left, scope, seen) + text(node.right, scope, seen);
    if (node?.type === "Identifier") {
      const binding = scope.get(node.name);
      if (binding && !seen.has(binding))
        return text(binding.node, binding.scope, new Set([...seen, binding]));
    }
    return " __dynamic__ ";
  }
  const result: string[] = [];
  function visit(node: any, inherited: Map<string, Binding>) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((part) => visit(part, inherited));
      return;
    }
    let scope = inherited;
    if (node.type === "Program" || node.type === "BlockStatement") {
      scope = new Map(inherited);
      for (const item of node.body) {
        const declaration =
          item.type === "ExportNamedDeclaration" ? item.declaration : item;
        if (declaration?.type === "VariableDeclaration")
          for (const entry of declaration.declarations)
            if (entry.id.type === "Identifier")
              scope.set(entry.id.name, {
                node: declaration.kind === "const" ? entry.init : undefined,
                scope,
              });
      }
    }
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    ) {
      scope = new Map(scope);
      for (const param of node.params)
        if (param.type === "Identifier")
          scope.set(param.name, { node: undefined, scope });
    }
    if (
      node.type === "CallExpression" &&
      (node.callee.name === "statement" ||
        scope.get(node.callee.name)?.node?.callee?.name === "statementVariants")
    )
      result.push(text(node.arguments[0], scope));
    for (const part of Object.values(node)) visit(part, scope);
  }
  visit(ast, new Map());
  return result;
}

// SQL tokens preserve strings and quoted identifiers, but drop comments. Each
// SELECT/UPDATE/DELETE subquery gets its own alias scope; correlated references
// walk outward. UNION arms are separate scopes, so aliases cannot leak across.
function sqlPaths(sql: string): string[] {
  const tokens = [
    ...sql.matchAll(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w]*|[^\s]/g,
    ),
  ]
    .map((m) => m[0])
    .filter((s) => !s.startsWith("--") && !s.startsWith("/*"));
  type Scope = {
    parent?: Scope;
    aliases: Map<string, string>;
    tables: Set<string>;
  };
  const make = (parent?: Scope): Scope => ({
    parent,
    aliases: new Map(),
    tables: new Set(),
  });
  const outer = make();
  const scopes: Scope[] = [];
  const stack: Scope[] = [];
  let scope = outer;
  const word = (value = "") =>
    value.replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
  const reserved = new Set([
    "where",
    "set",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "cross",
    "on",
    "order",
    "group",
    "limit",
    "returning",
    "union",
    "having",
    "values",
    "using",
    "indexed",
    "not",
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const token = word(tokens[i]);
    if (token === "(") {
      stack.push(scope);
      if (["select", "with"].includes(word(tokens[i + 1]))) scope = make(scope);
    } else if (token === ")") scope = stack.pop() ?? outer;
    else if (token === "union" || token === "except" || token === "intersect")
      scope = make(scope.parent);
    scopes[i] = scope;
    if (!["from", "join", "update", "into"].includes(token)) continue;
    const table = word(tokens[i + 1]);
    if (!/^[a-z_]\w*$/.test(table)) continue;
    scope.tables.add(table);
    scope.aliases.set(table, table);
    const offset = word(tokens[i + 2]) === "as" ? 3 : 2;
    const alias = word(tokens[i + offset]);
    if (/^[a-z_]\w*$/.test(alias) && !reserved.has(alias))
      scope.aliases.set(alias, table);
  }
  const failures: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (word(tokens[i]) !== "json_extract" || tokens[i + 1] !== "(") continue;
    let at = i + 2;
    const first = word(tokens[at++]);
    let alias: string | undefined;
    let column = first;
    if (tokens[at] === ".") {
      alias = first;
      column = word(tokens[at + 1]);
      at += 2;
    }
    if (!["metadata", "payload"].includes(column) || tokens[at++] !== ",")
      continue;
    const paths: string[] = [];
    while (tokens[at]?.startsWith("'")) {
      if (tokens[at].startsWith("'$.")) paths.push(tokens[at]);
      at++;
      if (tokens[at++] !== ",") break;
    }
    if (!paths.length) continue;
    let current: Scope | undefined = scopes[i];
    let tables: string[] = [];
    while (current) {
      tables = alias
        ? current.aliases.has(alias)
          ? [current.aliases.get(alias)!]
          : []
        : [...current.tables];
      if (tables.length) break;
      current = current.parent;
    }
    if (!tables.length) {
      failures.push(
        `Unresolved SQL column ${alias ? alias + "." : ""}${column}`,
      );
      continue;
    }
    for (const table of tables) {
      const schemas = columns[`${table}.${column}`];
      for (const literal of paths) {
        const path = literal.slice(3, -1).split(".");
        if (schemas && !schemas.some((schema) => declared(schema, path)))
          failures.push(`${table}.${column} ${literal}`);
      }
    }
  }
  return failures;
}

// A deliberately syntactic guard: direct column names, column-bearing value
// names (messageMetadata/runPayload/artifactMetadata), and assignment targets.
// It does not follow arbitrary renaming or helper calls, or inspect SQL writes.
// A nested read such as payload.attachmentIds is not the whole JSON column.
const columnName = (name: unknown) =>
  typeof name === "string" &&
  /^(metadata|payload|messageMetadata|artifactMetadata|runPayload)$/.test(name);
function columnValue(node: any): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return columnName(node.name);
  if (node.type === "MemberExpression") return columnName(property(node));
  if (
    [
      "TSAsExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(node.type)
  )
    return columnValue(node.expression);
  if (
    node.type === "LogicalExpression" ||
    node.type === "ConditionalExpression"
  )
    return [node.left, node.right, node.consequent, node.alternate].some(
      columnValue,
    );
  if (node.type === "CallExpression") return node.arguments.some(columnValue);
  if (node.type === "ObjectExpression")
    return node.properties.some(
      (part: any) =>
        part.type === "SpreadElement" && columnValue(part.argument),
    );
  return false;
}
function rawAccess(ast: any): number {
  let count = 0;
  walk(ast, (node, parent) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      node.callee.object.name !== "JSON" ||
      !["parse", "stringify"].includes(property(node.callee))
    )
      return;
    const target =
      parent?.type === "Property"
        ? (parent.key.name ?? parent.key.value)
        : parent?.type === "VariableDeclarator"
          ? parent.id.name
          : parent?.type === "AssignmentExpression"
            ? (parent.left.name ?? property(parent.left))
            : undefined;
    if (columnValue(node.arguments[0]) || columnName(target)) count++;
  });
  return count;
}
const owners = new Set([
  "src/shared/message-metadata.ts",
  "src/shared/run-payload.ts",
  "src/shared/artifact-metadata.ts",
]);
// File + reason exemptions only shrink. These names refer to other JSON
// columns or external payloads; none exempts a messages/runs/artifacts codec.
const exemptions = new Map<string, string>([
  ["src/client/ConnectionDetails.tsx", "connections.metadata"],
  ["src/shared/workspace-events.ts", "events.payload transport envelope"],
  ["src/server/mobile-return.ts", "events.payload transport envelope"],
  ["src/server/webhook-outbox.ts", "webhook delivery payload"],
  ["src/server/notifications.ts", "push notification payload"],
  ["src/server/feed-projector.ts", "feed_cards.payload projection"],
  ["src/server/webhooks.ts", "webhook delivery payload"],
  ["src/server/traces.ts", "run_traces.metadata"],
  ["src/server/native/supervisor.ts", "connections.metadata harness selection"],
  ["src/server/native/projects.ts", "connections.metadata native binding"],
  ["src/server/feed-card-read.ts", "feed_cards.payload projection"],
  ["src/server/mcp/catalog.ts", "connections.metadata catalog binding"],
  ["src/server/mcp/broker.ts", "connections.metadata MCP transport"],
  ["src/server/mcp/client.ts", "connections.metadata MCP configuration"],
  ["src/server/mcp/sessions.ts", "connections.metadata MCP transport"],
  ["src/server/db.ts", "events.payload transport envelope"],
]);

it("SQL JSON paths name fields declared by the column's shared schema", () => {
  const failures = files(join(root, "src/server/sql")).flatMap((file) =>
    queries(program(file, readFileSync(file, "utf8"))).flatMap((sql) =>
      sqlPaths(sql).map((failure) => `${relative(root, file)}: ${failure}`),
    ),
  );
  expect([...new Set(failures)]).toEqual([]);
});
it("raw column codecs stay in their shared owner or shrinking file exemptions", () => {
  const found = files(join(root, "src"))
    .map(
      (file) =>
        [
          relative(root, file),
          rawAccess(program(file, readFileSync(file, "utf8"))),
        ] as const,
    )
    .filter(([, count]) => count);
  expect(
    found
      .filter(([file]) => !owners.has(file) && !exemptions.has(file))
      .map(([file]) => file),
  ).toEqual([]);
  expect(
    [...exemptions.keys()].filter(
      (file) => !found.some(([path]) => path === file),
    ),
    "Remove obsolete exemptions",
  ).toEqual([]);
});
it("rejects undeclared nested paths and resolves aliases by query scope", () => {
  expect(
    sqlPaths(
      "SELECT json_extract(m.metadata,'$.automation.typo') FROM messages m",
    ),
  ).toEqual(["messages.metadata '$.automation.typo'"]);
  expect(
    sqlPaths("SELECT json_extract(a.metadata,'$.name') FROM artifacts AS a"),
  ).toEqual([]);
  expect(
    sqlPaths(
      "SELECT json_extract(c.metadata,'$.transport') FROM connections c",
    ),
  ).toEqual([]);
  expect(
    sqlPaths(
      "SELECT json_extract(m.metadata,'$.typo') FROM messages m WHERE EXISTS(SELECT 1 FROM connections m WHERE json_extract(m.metadata,'$.transport')='stdio')",
    ),
  ).toEqual(["messages.metadata '$.typo'"]);
  expect(
    sqlPaths(
      "SELECT json_extract(r.payload,'$.typo') FROM messages m WHERE EXISTS(SELECT 1 FROM runs r)",
    ),
  ).toEqual(["Unresolved SQL column r.payload"]);
  expect(
    sqlPaths(
      "SELECT json_extract(metadata,'$.typo') FROM messages UNION SELECT json_extract(metadata,'$.transport') FROM connections",
    ),
  ).toEqual(["messages.metadata '$.typo'"]);
});
it("reads composed statement literals and variant literals without treating comments as code", () => {
  const ast = program(
    "fixture.ts",
    'const clause=" WHERE json_extract(m.metadata,\'$.bad\')=1"; const q=statement(`SELECT * FROM messages m${clause}`); const variant=statementVariants(); variant("SELECT json_extract(payload,\'$.bad\') FROM runs", db); // statement("ignored")',
  );
  expect(queries(ast).flatMap(sqlPaths)).toEqual([
    "messages.metadata '$.bad'",
    "runs.payload '$.bad'",
  ]);
});
it("detects direct codecs, computed properties and writes while ignoring other data", () => {
  const ast = program(
    "fixture.ts",
    `JSON.parse(message.metadata); JSON['parse'](run['payload'] ?? '{}'); JSON.stringify(messageMetadata); const row={metadata:JSON.stringify({progress:true})}; run.payload=JSON.stringify({}); JSON.stringify({...metadata, progress:true}); JSON.stringify(run.payload.attachmentIds); JSON.parse(other); // JSON.parse(message.metadata)`,
  );
  expect(rawAccess(ast)).toBe(6);
});

it("does not resolve a local SQL name through another function's binding", () => {
  const ast = program(
    "fixture.ts",
    `const sql="SELECT json_extract(metadata,'$.bad') FROM messages";
    function outer(){statement(sql);}
    function inner(){const sql="SELECT json_extract(metadata,'$.transport') FROM connections";statement(sql);}
    function dynamic(sql:string){statement(sql);}`,
  );
  expect(queries(ast).flatMap(sqlPaths)).toEqual(["messages.metadata '$.bad'"]);
});

it("checks every literal path in a multi-path extraction", () => {
  expect(
    sqlPaths("SELECT json_extract(payload,'$.model','$.typo') FROM runs"),
  ).toEqual(["runs.payload '$.typo'"]);
});
