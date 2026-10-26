import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSync } from "rolldown/utils";

// Source boundaries described in docs/architecture.md.
const forbidden: Record<string, string[]> = {
  client: ["server"],
  server: ["client"],
  shared: ["client", "server"],
};

const root = resolve(import.meta.dirname, "..");
const source = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return source(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });

// Module specifiers from the syntax tree, so comments, strings and regular
// expressions never count. Covers static, type-only, side-effect, re-export,
// dynamic, require, `import x = require()` and `import("...")` type forms.
function specifiers(file: string, text: string) {
  const { program, errors } = parseSync(file, text);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const found: string[] = [];
  const literal = (node: any) =>
    node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const specifier =
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ImportExpression" ||
      node.type === "TSImportType"
        ? literal(node.source)
        : node.type === "TSExternalModuleReference"
          ? literal(node.expression)
          : node.type === "CallExpression" &&
              node.callee?.type === "Identifier" &&
              node.callee.name === "require"
            ? literal(node.arguments[0])
            : undefined;
    if (specifier !== undefined) found.push(specifier);
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return found;
}

const area = (path: string) => relative(join(root, "src"), path).split(sep)[0];

it("reads every import form and ignores imports in comments and strings", () => {
  const text = [
    `import type { A } from "./a"; // import "./comment"`,
    `const s = "import './string'", r = /import ".\\/regex"/;`,
    `const b = require("./b"); const c = () => import(/* x */ "./c");`,
    `export * from "./d"; export { e } from "./e"; import "./f";`,
    `import g = require("./g"); type H = import("./h").H;`,
  ].join("\n");
  expect(specifiers("probe.ts", text).sort()).toEqual(
    ["./a", "./b", "./c", "./d", "./e", "./f", "./g", "./h"].sort(),
  );
});

it("keeps client, server and shared code from importing across their boundary", () => {
  const violations: string[] = [];
  let checked = 0;
  for (const file of source(join(root, "src"))) {
    const from = area(file);
    for (const specifier of specifiers(file, readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const to = area(resolve(dirname(file), specifier));
      if (from !== to) checked++;
      if (forbidden[from]?.includes(to))
        violations.push(`${relative(root, file)} imports ${specifier}`);
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(violations).toEqual([]);
});
