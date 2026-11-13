import { parseSync, Visitor } from "vite";
import { globSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { BUILD_ASSETS } from "../src/shared/build-assets.ts";
const assets = BUILD_ASSETS.filter((asset) =>
  asset.uses.includes("support"),
).map((asset) => asset.path);

/** Keep module-relative runtime inputs inside the generated distribution.
 * The orchestrator invokes this in the same source archive as compilation. */
export async function stageRuntimeAssets(root, output) {
  root = resolve(root);
  output = resolve(output);
  const support = join(output, "support");
  for (const asset of assets)
    await cp(join(root, asset), join(support, asset), {
      recursive: true,
      filter: (path) =>
        !relative(root, path)
          .split(sep)
          .some((part) => part === "node_modules" || part === ".git"),
    });
  for (const file of globSync("**/*.{js,mjs}", { cwd: output })) {
    if (/^(?:support|web)\//.test(file)) continue;
    const path = join(output, file);
    const code = await readFile(path, "utf8");
    const parsed = parseSync(path, code, { sourceType: "module" });
    if (parsed.errors.length)
      throw new Error(`Cannot parse compiled module ${file}`);
    const edits = [];
    const relocate = (literal) => {
      if (
        literal?.type !== "Literal" ||
        typeof literal.value !== "string" ||
        !literal.value.startsWith(".")
      )
        return;
      const target = relative(root, resolve(dirname(path), literal.value));
      if (
        !assets.some(
          (asset) => target === asset || target.startsWith(asset + sep),
        )
      )
        return;
      let replacement = relative(dirname(path), join(support, target))
        .split(sep)
        .join("/");
      if (!replacement.startsWith(".")) replacement = "./" + replacement;
      if (literal.value.endsWith("/") && !replacement.endsWith("/"))
        replacement += "/";
      edits.push({
        start: literal.start,
        end: literal.end,
        text: JSON.stringify(replacement),
      });
    };
    const resources = (part) => {
      relocate(part);
      if (part?.type === "BinaryExpression" && part.operator === "+") {
        resources(part.left);
        resources(part.right);
      }
    };
    // Native build scripts load shared TypeScript directly. Compiled modules
    // must resolve those same dependencies from their emitted JavaScript.
    const moduleImport = (literal) => {
      if (
        literal?.type === "Literal" &&
        typeof literal.value === "string" &&
        literal.value.startsWith(".") &&
        literal.value.endsWith(".ts")
      ) {
        edits.push({
          start: literal.start,
          end: literal.end,
          text: JSON.stringify(literal.value.slice(0, -3) + ".js"),
        });
      } else relocate(literal);
    };
    new Visitor({
      ImportDeclaration: (node) => moduleImport(node.source),
      ExportNamedDeclaration: (node) => moduleImport(node.source),
      ExportAllDeclaration: (node) => moduleImport(node.source),
      ImportExpression: (node) => moduleImport(node.source),
      NewExpression(node) {
        const base = node.arguments[1];
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "URL" &&
          base &&
          code.slice(base.start, base.end) === "import.meta.url"
        )
          resources(node.arguments[0]);
      },
    }).visit(parsed.program);
    let result = code;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    if (edits.length) await writeFile(path, result);
  }
}
