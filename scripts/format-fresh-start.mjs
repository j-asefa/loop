import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as prettier from "prettier";

// F2: review this driver before committing its mechanical output separately.
// Apply: node scripts/format-fresh-start.mjs apply
// Verify: node scripts/format-fresh-start.mjs verify BEFORE MECHANICAL
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const blob = (ref, path) => git("show", `${ref}:${path}`);
const tree = (ref) =>
  new Map(
    git("ls-tree", "-rz", ref)
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [metadata, path] = entry.split("\t");
        const [mode, type, hash] = metadata.split(" ");
        return [path, { mode, type, hash }];
      }),
  );
const [action, beforeArg, afterArg, extra] = process.argv.slice(2);
assert(
  !extra && (action === "apply" || action === "verify"),
  "Use apply or verify BEFORE MECHANICAL",
);
assert(action === "verify" ? beforeArg && afterArg : !beforeArg && !afterArg);
const before = git(
  "rev-parse",
  "--verify",
  `${beforeArg || "HEAD"}^{commit}`,
).trim();
const paths = blob(before, ".prettierignore")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
assert.equal(new Set(paths).size, paths.length, "Ignore paths must be unique");
const source = tree(before);
const config = JSON.parse(blob(before, ".prettierrc.json"));
assert.deepEqual(
  config,
  {},
  "Review changes to the formatter configuration first",
);
const manifest = JSON.parse(blob(before, "package.json"));
const lock = JSON.parse(blob(before, "package-lock.json"));
assert.equal(prettier.version, manifest.devDependencies.prettier);
assert.equal(prettier.version, lock.packages["node_modules/prettier"].version);
const output = new Map();
for (const path of paths) {
  assert(
    /^(src|test|scripts)\/[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|mjs|cjs)$/.test(
      path,
    ),
    `Not a concrete source path: ${path}`,
  );
  assert(!path.split("/").includes(".."));
  assert.equal(source.get(path)?.type, "blob", path);
  assert.equal(source.get(path)?.mode, "100644", path);
  output.set(
    path,
    await prettier.format(blob(before, path), { ...config, filepath: path }),
  );
}
if (action === "apply") {
  assert.equal(
    git("status", "--porcelain"),
    "",
    "Apply only to a clean worktree",
  );
  for (const [path, formatted] of output) {
    assert.equal(readFileSync(path, "utf8"), blob(before, path), path);
    writeFileSync(path, formatted);
  }
  console.log(
    `Formatted ${paths.length} named paths with Prettier ${prettier.version}; base ${before}. Commit only this output, then verify its tree.`,
  );
} else {
  const after = git("rev-parse", "--verify", `${afterArg}^{commit}`).trim();
  const target = tree(after);
  assert.deepEqual(
    [...target.keys()],
    [...source.keys()],
    "Mechanical commit may not add or remove paths",
  );
  for (const [path, entry] of source) {
    if (!output.has(path))
      assert.deepEqual(target.get(path), entry, `Unexpected change: ${path}`);
    else {
      assert.equal(target.get(path).mode, entry.mode, path);
      assert.equal(target.get(path).type, entry.type, path);
      assert.equal(
        blob(after, path),
        output.get(path),
        `Regenerated output differs: ${path}`,
      );
    }
  }
  console.log(
    `PARITY PASS: ${paths.length} formatted paths; every other tree entry unchanged; Prettier ${prettier.version}; tree ${git("rev-parse", `${after}^{tree}`).trim()}`,
  );
}
