import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";

const names = new Set([
  "state",
  "status",
  "kind",
  "role",
  "origin",
  "stage",
  "outcome",
  "mode",
  "phase",
]);
type Module = {
  source: string;
  program: any;
  definitions: Map<string, any>;
  imports: Map<string, [string, string]>;
};
function inventory(
  sources: Map<string, string>,
  directory = resolve("src/shared"),
) {
  const modules = new Map<string, Module>();
  const importTarget = (file: string, specifier: string) => {
    if (!specifier.startsWith(".")) return specifier;
    const path = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
    return sources.has(path)
      ? path
      : sources.has(path + ".ts")
        ? path + ".ts"
        : path;
  };
  for (const [file, source] of sources) {
    const { program, errors } = parseSync(file, source);
    if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
    const definitions = new Map<string, any>(),
      imports = new Map<string, [string, string]>();
    for (const statement of (program as any).body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type === "VariableDeclaration")
        for (const entry of declaration.declarations)
          if (entry.id.type === "Identifier")
            definitions.set(entry.id.name, entry.init);
      if (statement.type === "ExportNamedDeclaration" && statement.source) {
        const target = importTarget(file, statement.source.value);
        for (const spec of statement.specifiers)
          if (spec.type === "ExportSpecifier")
            imports.set(spec.exported.name ?? spec.exported.value, [
              target,
              spec.local.name ?? spec.local.value,
            ]);
      }
      if (
        statement.type === "ImportDeclaration" &&
        statement.importKind !== "type"
      ) {
        const target = importTarget(file, statement.source.value);
        for (const spec of statement.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.importKind !== "type")
            imports.set(spec.local.name, [
              target,
              spec.imported.name ?? spec.imported.value,
            ]);
          else if (spec.type === "ImportNamespaceSpecifier")
            imports.set(spec.local.name, [target, "*"]);
        }
      }
    }
    modules.set(file, { source, program, definitions, imports });
  }
  // Resolve aliases in the lexical environment of each expression, not a
  // module-wide name table. Inner declarations must not overwrite siblings.
  const scopes = new WeakMap<object, Map<string, any>>();
  for (const module of modules.values()) {
    function bind(node: any, inherited: Map<string, any>) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) bind(child, inherited);
        return;
      }
      let scope = inherited;
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(node.type)
      ) {
        scope = new Map(inherited);
        // var belongs to the function even when declared inside a block.
        function hoist(value: any) {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            for (const child of value) hoist(child);
            return;
          }
          if (
            [
              "FunctionDeclaration",
              "FunctionExpression",
              "ArrowFunctionExpression",
            ].includes(value.type)
          )
            return;
          if (value.type === "VariableDeclaration" && value.kind === "var")
            for (const entry of value.declarations)
              if (entry.id.type === "Identifier")
                scope.set(entry.id.name, entry.init);
          for (const child of Object.values(value)) hoist(child);
        }
        for (const parameter of node.params)
          if (parameter.type === "Identifier")
            scope.set(parameter.name, undefined);
        hoist(node.body);
      }
      if (node.type === "BlockStatement") {
        scope = new Map(scope);
        for (const statement of node.body)
          if (statement.type === "VariableDeclaration")
            for (const declaration of statement.declarations)
              if (declaration.id.type === "Identifier")
                scope.set(declaration.id.name, declaration.init);
      }
      scopes.set(node, scope);
      for (const value of Object.values(node)) bind(value, scope);
    }
    bind(module.program, module.definitions);
  }
  const imported = (file: string, node: any, name: string) =>
    scopes.get(node)?.has(name)
      ? undefined
      : modules.get(file)?.imports.get(name);
  function open(file: string, node: any, seen = new Set<any>()): boolean {
    if (!node) return false;
    if (
      [
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSNonNullExpression",
      ].includes(node.type)
    )
      return open(file, node.expression, seen);
    const module = modules.get(file);
    if (node.type === "Identifier") {
      const scope = scopes.get(node) ?? module?.definitions;
      const binding = scope?.get(node.name);
      const key = scope?.has(node.name)
        ? (binding ?? node)
        : `${file}:${node.name}`;
      if (seen.has(key)) return false;
      const next = new Set([...seen, key]);
      const reference = imported(file, node, node.name);
      if (reference)
        return open(
          reference[0],
          { type: "Identifier", name: reference[1] },
          next,
        );
      return open(file, binding, next);
    }
    if (node.type === "MemberExpression" && node.object.type === "Identifier") {
      const reference = imported(file, node, node.object.name);
      if (reference?.[1] === "*")
        return open(
          reference[0],
          {
            type: "Identifier",
            name: node.property.name ?? node.property.value,
          },
          seen,
        );
    }
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression"
    )
      return false;
    const { object, property } = node.callee,
      method = property.name ?? property.value;
    const receiver =
      object.type === "MemberExpression" && object.property.name === "coerce"
        ? object.object
        : object;
    if (
      receiver.type === "Identifier" &&
      imported(file, node, receiver.name)?.[0] === "zod"
    ) {
      if (method === "string") return true;
      if (method === "union")
        return (
          node.arguments[0]?.elements?.some((part: any) =>
            open(file, part, seen),
          ) ?? false
        );
      return false;
    }
    if (method === "or")
      return (
        open(file, object, seen) ||
        node.arguments.some((part: any) => open(file, part, seen))
      );
    return open(file, object, seen);
  }
  const found = new Map<string, string>();
  for (const [file, module] of modules) {
    // Fleet schemas remain outside this package, including fleet.ts.
    if (/^fleet(?:-|\.)/.test(basename(file))) continue;
    function walk(node: any, path: string[] = []) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, path);
        return;
      }
      if (node.type === "FunctionDeclaration" && node.id) {
        walk(node.body, [...path, node.id.name]);
        return;
      }
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        walk(node.init, [node.id.name]);
        return;
      }
      if (node.type === "Property") {
        const field = node.key.name ?? node.key.value;
        const next = typeof field === "string" ? [...path, field] : path;
        if (names.has(field) && open(file, node.value)) {
          const key = `${relative(directory, file).split("\\").join("/")}:${next.join(".")}`;
          if (found.has(key))
            throw new Error(`Ambiguous schema declaration: ${key}`);
          found.set(key, module.source.slice(node.value.start, node.value.end));
        }
        walk(node.value, next);
        return;
      }
      for (const value of Object.values(node)) walk(value, path);
    }
    walk(module.program);
  }
  return found;
}

// Exact declaration paths, with source-verifiable reasons; no count allowance.
const exemptions = new Map<string, string>([
  [
    "agent-activities.ts:ActivitySource.origin",
    "Harness producer origin (broker, loop_plan, codex or adapter identity).",
  ],
  [
    "agent-contract-schemas.ts:PublicHarnessCommand.kind",
    "Harness-defined command kinds.",
  ],
  [
    "agent-contract-schemas.ts:PublicHarnessCommand.sourceInfo.origin",
    "Harness command provenance text.",
  ],
  [
    "agent-contract-schemas.ts:PublicPiInventory.diagnostics.kind",
    "Pi-provided diagnostic entry kinds.",
  ],
  [
    "companion-contract-schemas.ts:PublicNativeHistory.managed.state",
    "Companion-reported native history state; no in-repository producer.",
  ],
  [
    "conversation-routes.ts:conversationRoutes.nativeAnswer.response.state",
    "Harness answer outcome; not a Loop run state.",
  ],
  [
    "execution-authority.ts:executionOperations.native.answer.state",
    "Native answer reply spans harness-confirmed outcome stages.",
  ],
  [
    "execution-authority.ts:ExecutionParentMessage.origin",
    "Execution parent request origin text.",
  ],
  [
    "library-contract-schemas.ts:SearchQuery.kind",
    "Existing request accepts arbitrary exact-match kind filters; nonstrings fall back to undefined. Preserve D1 acceptance (workspace-routes search, sql/search-documents filterSql).",
  ],
  [
    "library-contract-schemas.ts:PublicSearchItem.kind",
    "Search document kind spans message and artifact domains.",
  ],
  [
    "mcp-contract-schemas.ts:PublicAgentSources.kind",
    "Transport kind supplied by source discovery.",
  ],
  ["native-commands.ts:NativeCommand.kind", "Harness-defined command kind."],
  [
    "native-commands.ts:NativeCommand.sourceInfo.origin",
    "Harness command provenance text.",
  ],
  [
    "session-controls.ts:SessionControls.state",
    "Companion session-control state; no in-repository producer.",
  ],
  [
    "social-contract-schemas.ts:PublicFeedEntry.kind",
    "Feed source kind supplied by catalog.",
  ],
  [
    "workspace-events.ts:Payloads.run.failed.phase",
    "Failure phase is free diagnostic text.",
  ],
]);

it("keeps discriminating fields in src/shared as closed sets", () => {
  const directory = resolve("src/shared");
  const readSources = (folder: string): [string, string][] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(folder, entry.name);
      return entry.isDirectory()
        ? readSources(path)
        : path.endsWith(".ts")
          ? [[path, readFileSync(path, "utf8")]]
          : [];
    });
  const sources = new Map(readSources(directory));
  const found = inventory(sources);
  expect(
    [...found.keys()].filter((key) => !exemptions.has(key)),
    "Open selectors need a named schema exemption",
  ).toEqual([]);
  expect(
    [...exemptions.keys()].filter((key) => !found.has(key)),
    "Remove obsolete exceptions",
  ).toEqual([]);
});

it("finds aliased and multiline schemas while ignoring comments, values and closed sets", () => {
  const sources = new Map([
    [
      resolve("fixture/base.ts"),
      `import {z} from 'zod'; export const Text=z.string();`,
    ],
    [
      resolve("fixture/forward.ts"),
      `export {Text as Forward} from "./base.js";`,
    ],
    [
      resolve("fixture/check.ts"),
      `import {z} from 'zod'; import {Text as Value} from './base'; import * as Base from './base.js'; import {Forward} from './forward.js';
      const Alias=Value.optional().catch(undefined);
      // state: z.string(),
      const description="kind: z.string()";
      const Schema=z.object({state:\n Alias, nested:z.object({kind:z.union([z.literal('a'),Value])}),
        outcome: Forward, phase: Base.Text, mode:z.coerce.string().optional(), role:z.enum(['user','agent']), status:z.literal('ready'), origin:z.string().brand<'Identity'>()});`,
    ],
    [
      resolve("fixture/nested/check.ts"),
      `import {z} from 'zod'; import {Text} from '../base.js'; const Schema=z.object({kind:Text});`,
    ],
  ]);
  expect([...inventory(sources, resolve("fixture")).keys()]).toEqual([
    "check.ts:Schema.state",
    "check.ts:Schema.nested.kind",
    "check.ts:Schema.outcome",
    "check.ts:Schema.phase",
    "check.ts:Schema.mode",
    "check.ts:Schema.origin",
    "nested/check.ts:Schema.kind",
  ]);
});

it("resolves function-local aliases, shadowed imports and nested block bindings", () => {
  const file = resolve("fixture/local.ts");
  const found = inventory(
    new Map([
      [
        file,
        `import {z} from 'zod';
 const Text=z.literal('closed');
 function build(){const Text=z.string();return z.object({state:Text});}
 function hoisted(Text){if(true){var Text=z.string();}return z.object({phase:Text});}
 function sibling(){const Text=z.literal('closed');return z.object({kind:Text});}
 function nested(){const Alias=z.string();{const Alias=z.literal('closed');const Inner=z.object({role:Alias});}return z.object({status:Alias});}
 `,
      ],
    ]),
    resolve("fixture"),
  );
  expect([...found.keys()]).toEqual([
    "local.ts:build.state",
    "local.ts:hoisted.phase",
    "local.ts:nested.status",
  ]);
  const sources = new Map([
    [
      resolve("fixture/base.ts"),
      `import {z} from 'zod';export const Text=z.string();`,
    ],
    [
      file,
      `import {z} from 'zod';import {Text} from './base.js';function closed(){const Text=z.literal('ready');return z.object({state:Text});}function opaque(){const Alias=Text.optional();return z.object({origin:Alias});}`,
    ],
  ]);
  expect([...inventory(sources, resolve("fixture")).keys()]).toEqual([
    "local.ts:opaque.origin",
  ]);
});
