import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
function inventory(sources: Map<string, string>) {
  const modules = new Map<string, Module>();
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
        const target = resolve(
          dirname(file),
          statement.source.value.replace(/\.js$/, ".ts"),
        );
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
        const target = statement.source.value.startsWith(".")
          ? resolve(
              dirname(file),
              statement.source.value.replace(/\.js$/, ".ts"),
            )
          : statement.source.value;
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
  function open(file: string, node: any, seen = new Set<string>()): boolean {
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
      const key = `${file}:${node.name}`;
      if (seen.has(key)) return false;
      const next = new Set([...seen, key]),
        imported = module?.imports.get(node.name);
      if (imported)
        return open(
          imported[0],
          { type: "Identifier", name: imported[1] },
          next,
        );
      return open(file, module?.definitions.get(node.name), next);
    }
    if (node.type === "MemberExpression" && node.object.type === "Identifier") {
      const imported = module?.imports.get(node.object.name);
      if (imported?.[1] === "*")
        return open(
          imported[0],
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
      module?.imports.get(receiver.name)?.[0] === "zod"
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
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        walk(node.init, [node.id.name]);
        return;
      }
      if (node.type === "Property") {
        const field = node.key.name ?? node.key.value;
        const next = typeof field === "string" ? [...path, field] : path;
        if (names.has(field) && open(file, node.value)) {
          const key = `${basename(file)}:${next.join(".")}`;
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
  const sources = new Map(
    readdirSync(directory)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => {
        const path = resolve(directory, file);
        return [path, readFileSync(path, "utf8")];
      }),
  );
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
      `import {z} from 'zod'; import {Text as Value} from './base.js'; import * as Base from './base.js'; import {Forward} from './forward.js';
      const Alias=Value.optional().catch(undefined);
      // state: z.string(),
      const description="kind: z.string()";
      const Schema=z.object({state:\n Alias, nested:z.object({kind:z.union([z.literal('a'),Value])}),
        outcome: Forward, phase: Base.Text, mode:z.coerce.string().optional(), role:z.enum(['user','agent']), status:z.literal('ready'), origin:z.string().brand<'Identity'>()});`,
    ],
  ]);
  expect([...inventory(sources).keys()]).toEqual([
    "check.ts:Schema.state",
    "check.ts:Schema.nested.kind",
    "check.ts:Schema.outcome",
    "check.ts:Schema.phase",
    "check.ts:Schema.mode",
    "check.ts:Schema.origin",
  ]);
});
