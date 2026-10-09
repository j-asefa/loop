import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Problem } from "./domain.js";

export type ReviewScope = "uncommitted" | "staged" | "branch";
export type ReviewSnapshot = {
  scope: ReviewScope;
  base: string;
  head: string;
  diff: string;
  files: Record<string, string>;
  before: Record<string, string>;
  changed: string[];
  omitted: string[];
};
const MAX_FILE = 512_000,
  MAX_TOTAL = 16_000_000;
const excluded = (path: string) =>
  path
    .split("/")
    .some(
      (p) =>
        p.startsWith(".") ||
        ["node_modules", "vendor", "dist", "build", "coverage"].includes(p),
    ) ||
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|credentials[^/]*|secrets?[^/]*|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i.test(
    path,
  );
export const snapshotFingerprint = (s: ReviewSnapshot) =>
  createHash("sha256").update(JSON.stringify(s)).digest("hex");

/** No shell, external diff drivers, textconv, hooks, checkout, or index writes. */
export function captureSnapshot(
  directory: string,
  scope: ReviewScope,
  base = "main",
): ReviewSnapshot {
  const root = realpathSync(directory);
  const git = (args: string[], maxBuffer = 5_000_000) => {
    try {
      return execFileSync(
        "git",
        ["--literal-pathspecs", "-c", "core.quotePath=false", ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10000,
          maxBuffer,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_EXTERNAL_DIFF: "",
            GIT_CONFIG_COUNT: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Problem(
        422,
        "Could not capture this Git snapshot. Check the base reference and repository size.",
      );
    }
  };
  if (realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== root)
    throw new Problem(
      422,
      "Bind the project to the repository root to review changes",
    );
  const head = git(["rev-parse", "--verify", "HEAD"]).trim();
  const baseSha =
    scope === "branch"
      ? git([
          "merge-base",
          git([
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${base}^{commit}`,
          ]).trim(),
          head,
        ]).trim()
      : head;
  const compare =
    scope === "staged"
      ? ["--cached", head]
      : scope === "branch"
        ? [baseSha, head]
        : [head];
  const common = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const changed = git([...common, "--name-only", "-z", ...compare, "--"])
    .split("\0")
    .filter(Boolean);
  if (scope === "uncommitted")
    changed.push(
      ...git(["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    );
  const changes = [...new Set(changed)].sort();
  if (changes.length > 100)
    throw new Problem(413, "Review up to 100 changed files at a time");
  const files: Record<string, string> = Object.create(null),
    before: Record<string, string> = Object.create(null);
  const omitted = new Set(changes.filter(excluded));
  let total = 0;
  const text = (value: string, path: string) => {
    if (value.includes("\0") || Buffer.byteLength(value) > MAX_FILE) {
      omitted.add(path);
      return undefined;
    }
    total += Buffer.byteLength(value);
    if (total > MAX_TOTAL)
      throw new Problem(
        413,
        "Repository context exceeds 16 MB. Use a smaller repository for snapshot review.",
      );
    return value;
  };
  // Capture context as well as changed files, so reviewers can inspect callers.
  const entries =
    scope === "staged"
      ? git(["ls-files", "--stage", "-z"])
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t"),
              [mode, hash, stage] = line.slice(0, tab).split(" ");
            if (stage !== "0")
              throw new Problem(
                409,
                "Resolve merge conflicts before reviewing staged changes",
              );
            return { mode, hash, path: line.slice(tab + 1) };
          })
      : git(["ls-tree", "-r", "-z", head])
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t"),
              [mode, , hash] = line.slice(0, tab).split(" ");
            return { mode, hash, path: line.slice(tab + 1) };
          });
  if (scope === "uncommitted")
    for (const path of changes)
      if (!entries.some((e) => e.path === path))
        entries.push({ path, mode: "100644", hash: "" });
  if (entries.length > 2000)
    throw new Problem(
      413,
      "Snapshot reviews currently support repositories with up to 2,000 files",
    );
  for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    if (excluded(e.path) || !["100644", "100755"].includes(e.mode)) {
      omitted.add(e.path);
      continue;
    }
    let value: string;
    if (scope === "uncommitted") {
      const path = join(root, e.path);
      try {
        if (
          !lstatSync(path).isFile() ||
          realpathSync(path) !== resolve(root, e.path)
        ) {
          omitted.add(e.path);
          continue;
        }
        if (lstatSync(path).size > MAX_FILE) {
          omitted.add(e.path);
          continue;
        }
        value = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    } else {
      if (Number(git(["cat-file", "-s", e.hash])) > MAX_FILE) {
        omitted.add(e.path);
        continue;
      }
      value = git(["cat-file", "blob", e.hash]);
    }
    const content = text(value, e.path);
    if (content !== undefined) files[e.path] = content;
  }
  const oldEntries = git(["ls-tree", "-r", "-z", baseSha])
    .split("\0")
    .filter(Boolean);
  for (const line of oldEntries) {
    const tab = line.indexOf("\t"),
      path = line.slice(tab + 1),
      [mode, , hash] = line.slice(0, tab).split(" ");
    if (!changes.includes(path) || excluded(path)) continue;
    if (
      !["100644", "100755"].includes(mode) ||
      Number(git(["cat-file", "-s", hash])) > MAX_FILE
    ) {
      omitted.add(path);
      continue;
    }
    const content = text(git(["cat-file", "blob", hash]), path);
    if (content !== undefined) before[path] = content;
  }
  const selected = changes.filter((p) => !omitted.has(p));
  let diff = selected.length
    ? git([...common, "--unified=3", ...compare, "--", ...selected], 300000)
    : "";
  for (const path of selected) {
    if (
      !(path in before) &&
      path in files &&
      scope === "uncommitted" &&
      !diff.includes(`b/${path}`)
    )
      diff += `\nNew file: ${JSON.stringify(path)} (read its full contents with loop_review_read)\n`;
  }
  if (!selected.length)
    throw new Problem(422, "No reviewable changes in this scope");
  return {
    scope,
    base: baseSha,
    head,
    diff,
    files,
    before,
    changed: selected,
    omitted: [...omitted].sort(),
  };
}
