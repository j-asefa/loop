// One-off, deterministic rename of the product from Loop55 back to Loop.
// Text: LOOP55 -> LOOP, Loop55 -> Loop, loop55 -> loop; files with loop55 in
// their path are moved; side-effect imports of runtime/environment.mjs go;
// then the pinned Prettier reformats the source globs.
// Rerun on the same base commit to reproduce the mechanical part of the
// rename PR exactly; the hand-written changes are separate commits.
//
//   node scripts/rename-loop55-to-loop.mjs
//
// Released migrations are immutable and keep their text; migration 149 renames
// stored values instead. Migration identities ("loop55-names") are preserved.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const SELF = "scripts/rename-loop55-to-loop.mjs";
const excluded = (path) =>
  path === SELF ||
  /^migrations\/.*\.sql$/.test(path) ||
  path === "src/server/legacy-migrations.ts" ||
  path === "package-lock.json" ||
  path === ".git-blame-ignore-revs";
// Names that identify released migrations and the objects they created.
const protectedTokens = [
  /\b\d{3}-loop55-names\b/g,
  /\bloop55-names\b/g,
  /\bloop55_agent_origin\b/g,
  /\bloop55_conversation_origin\b/g,
];
const rename = (text) => {
  const kept = [];
  for (const pattern of protectedTokens)
    text = text.replace(pattern, (token) => {
      kept.push(token);
      return `\u0000${kept.length - 1}\u0000`;
    });
  text = text
    .replaceAll("LOOP55", "LOOP")
    .replaceAll("Loop55", "Loop")
    .replaceAll("loop55", "loop");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
};

let changed = 0;
for (const path of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (excluded(path)) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue; // binary
  const text = bytes.toString("utf8");
  // The LOOP_ -> LOOP55_ environment shim is deleted with the rename; drop
  // its side-effect imports. Its module and other references are hand edits.
  const next = rename(text).replace(
    /^import "(?:\.\.?\/)+(?:runtime\/)?environment\.mjs";\n/gm,
    "",
  );
  if (next !== text) {
    writeFileSync(path, next);
    changed++;
  }
}
let moved = 0;
for (const path of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (excluded(path) || !/loop55/i.test(path)) continue;
  git("mv", path, rename(path));
  moved++;
}
// Shorter names change line wrapping; reformat with the pinned Prettier
// (it honours .prettierignore).
execFileSync(
  process.execPath,
  [
    "node_modules/prettier/bin/prettier.cjs",
    "--write",
    "--log-level=warn",
    "{src,test,scripts}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  ],
  { stdio: "inherit" },
);
console.log(`rename: ${changed} files rewritten, ${moved} files moved`);
