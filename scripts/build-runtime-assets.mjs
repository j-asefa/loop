import { parseSync, Visitor } from "vite";
import { globSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compileRuntime } from "./compile-runtime.mjs";

const assets = [
  "runtime",
  "native",
  "migrations",
  "deployment",
  "package.json",
];

/** Keep module-relative runtime inputs inside the generated distribution.
 * The orchestrator invokes this in the same source archive as compilation. */
export async function stageRuntimeAssets(root, output) {
  root = resolve(root);
  output = resolve(output);
  const support = join(output, "support");
  for (const asset of assets.filter((asset) => asset !== "runtime"))
    await cp(join(root, asset), join(support, asset), {
      recursive: true,
      filter: (path) =>
        !relative(root, path)
          .split(sep)
          .some((part) => part === "node_modules" || part === ".git"),
    });
  await compileRuntime(root, join(support, "runtime"));
  for (const file of globSync("**/*.{js,mjs}", { cwd: output })) {
    if (/^(?:support|client|web)\//.test(file)) continue;
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
      const stagedTarget = target.startsWith("runtime" + sep)
        ? target.replace(/\.ts$/, ".mjs")
        : target;
      let replacement = relative(dirname(path), join(support, stagedTarget))
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
    new Visitor({
      ImportDeclaration: (node) => relocate(node.source),
      ExportNamedDeclaration: (node) => relocate(node.source),
      ExportAllDeclaration: (node) => relocate(node.source),
      ImportExpression: (node) => relocate(node.source),
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
