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
  const gitBytes = (args: string[], maxBuffer = 5_000_000, input?: string) => {
    try {
      return execFileSync(
        "git",
        ["--literal-pathspecs", "-c", "core.quotePath=false", ...args],
        {
          cwd: root,
          encoding: null,
          input,
          timeout: 10000,
          maxBuffer,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_EXTERNAL_DIFF: "",
            GIT_CONFIG_COUNT: "0",
          },
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Problem(
        422,
        "Could not capture this Git snapshot. Check the base reference and repository size.",
      );
    }
  };
  const git = (args: string[], maxBuffer = 5_000_000, input?: string) =>
    gitBytes(args, maxBuffer, input).toString("utf8");
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
  type Entry = { mode: string; hash: string; path: string };
  // Starting Git once per file blocks the server for large repositories. Read
  // immutable objects in bounded batches, checking sizes before fetching data.
  function* blobs(
    entries: Entry[],
  ): Generator<{ entry: Entry; value: string }> {
    const eligible = entries.filter((entry) => {
      if (excluded(entry.path) || !["100644", "100755"].includes(entry.mode)) {
        omitted.add(entry.path);
        return false;
      }
      return true;
    });
    const invalid = () =>
      new Problem(422, "Could not read captured Git objects");
    for (let offset = 0; offset < eligible.length; offset += 64) {
      const batch = eligible.slice(offset, offset + 64);
      const checks = git(
        ["cat-file", "--batch-check"],
        32_000,
        batch.map((entry) => entry.hash).join("\n") + "\n",
      )
        .trimEnd()
        .split("\n");
      if (checks.length !== batch.length) throw invalid();
      const selected = batch.filter((entry, index) => {
        const [hash, kind, size] = checks[index].split(" ");
        if (hash !== entry.hash || kind !== "blob" || !/^\d+$/.test(size))
          throw invalid();
        if (Number(size) > MAX_FILE) {
          omitted.add(entry.path);
          return false;
        }
        return true;
      });
      if (!selected.length) continue;
      const data = gitBytes(
        ["cat-file", "--batch"],
        MAX_FILE * selected.length + 32_000,
        selected.map((entry) => entry.hash).join("\n") + "\n",
      );
      let cursor = 0;
      for (const entry of selected) {
        const newline = data.indexOf(10, cursor);
        if (newline < 0) throw invalid();
        const [hash, kind, bytes] = data
          .toString("ascii", cursor, newline)
          .split(" ");
        const size = Number(bytes);
        if (
          hash !== entry.hash ||
          kind !== "blob" ||
          !/^\d+$/.test(bytes) ||
          size > MAX_FILE
        )
          throw invalid();
        const end = newline + 1 + size;
        if (end >= data.length || data[end] !== 10) throw invalid();
        yield { entry, value: data.toString("utf8", newline + 1, end) };
        cursor = end + 1;
      }
      if (cursor !== data.length) throw invalid();
    }
  }
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
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const captured =
    scope === "uncommitted"
      ? entries.map((entry) => ({
          entry,
          value: undefined as string | undefined,
        }))
      : blobs(entries);
  for (const { entry: e, value: blob } of captured) {
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
      value = blob!;
    }
    const content = text(value, e.path);
    if (content !== undefined) files[e.path] = content;
  }
  const oldEntries = git(["ls-tree", "-r", "-z", baseSha])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t"),
        [mode, , hash] = line.slice(0, tab).split(" ");
      return { mode, hash, path: line.slice(tab + 1) };
    })
    .filter((entry) => changes.includes(entry.path));
  for (const { entry, value } of blobs(oldEntries)) {
    const content = text(value, entry.path);
    if (content !== undefined) before[entry.path] = content;
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
      diff += `\nNew file: ${JSON.stringify(path)} (read its full contents with loop55_review_read)\n`;
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
