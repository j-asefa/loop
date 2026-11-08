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
  context: Record<string, string>;
  changed: string[];
  omitted: string[];
};
const MAX_FILE = 512_000,
  MAX_TOTAL = 16_000_000,
  MAX_CONTEXT_FILES = 20_000,
  MAX_OMITTED_PATHS = 2_000,
  MAX_OMITTED_BYTES = 128_000;
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
        [
          "--no-replace-objects",
          "--literal-pathspecs",
          "-c",
          "core.quotePath=false",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.trustctime=true",
          "-c",
          "core.checkStat=default",
          "-c",
          "core.ignorestat=false",
          ...args,
        ],
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
            GIT_ALLOW_PROTOCOL: "",
            GIT_NO_LAZY_FETCH: "1",
            GIT_NO_REPLACE_OBJECTS: "1",
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
  if (scope === "uncommitted") {
    // Flags and conversion filters can make Git's unchanged list differ from
    // working bytes. Refuse those cases before diff can invoke a clean filter.
    const tracked = git(["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
    if (tracked.some((entry) => /^[a-zS] /.test(entry)))
      throw new Problem(
        409,
        "Uncommitted snapshot reviews do not support assume-unchanged or skip-worktree index flags",
      );
    if (tracked.length > MAX_CONTEXT_FILES + MAX_OMITTED_PATHS + 100)
      throw new Problem(
        413,
        "Snapshot metadata exceeds the combined context, omission and changed-file limits",
      );
    const conversions = () =>
      new Problem(
        409,
        "Uncommitted snapshot reviews do not support Git content conversions; use staged or branch review",
      );
    const autocrlf = git([
      "config",
      "--default=false",
      "--get",
      "core.autocrlf",
    ])
      .trim()
      .toLowerCase();
    if (!["false", "no", "off", "0"].includes(autocrlf)) throw conversions();
    for (let offset = 0; offset < tracked.length;) {
      let input = "",
        bytes = 0,
        count = 0;
      while (offset < tracked.length && count < 1000 && bytes < 200_000) {
        const path = tracked[offset++].slice(2);
        input += path + "\0";
        bytes += Buffer.byteLength(path) + 1;
        count++;
      }
      const attributes = git(
        [
          "check-attr",
          "-z",
          "--stdin",
          "filter",
          "working-tree-encoding",
          "text",
          "eol",
          "ident",
          "crlf",
        ],
        5_000_000,
        input,
      ).split("\0");
      attributes.pop();
      if (attributes.length % 3)
        throw new Problem(422, "Could not inspect Git content conversions");
      for (let i = 2; i < attributes.length; i += 3)
        if (!["unspecified", "unset"].includes(attributes[i]))
          throw conversions();
    }
  }
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
    before: Record<string, string> = Object.create(null),
    context: Record<string, string> = Object.create(null);
  const omitted = new Set<string>();
  let omittedBytes = 0;
  const omit = (path: string) => {
    if (omitted.has(path)) return;
    const bytes = Buffer.byteLength(JSON.stringify(path)) + 1;
    if (
      omitted.size >= MAX_OMITTED_PATHS ||
      omittedBytes + bytes > MAX_OMITTED_BYTES
    )
      throw new Problem(
        413,
        "Snapshot omission metadata exceeds 2,000 paths or 128 KB",
      );
    omittedBytes += bytes;
    omitted.add(path);
  };
  changes.filter(excluded).forEach(omit);
  let total = 0;
  const text = (value: string, path: string) => {
    if (value.includes("\0") || Buffer.byteLength(value) > MAX_FILE) {
      omit(path);
      return undefined;
    }
    total += Buffer.byteLength(value);
    if (total > MAX_TOTAL)
      throw new Problem(
        413,
        "Changed snapshot content exceeds 16 MB. Review fewer changes at a time.",
      );
    return value;
  };
  type Entry = { mode: string; hash: string; path: string };
  // Starting Git once per file blocks the server for large repositories. Read
  // immutable objects in bounded batches, checking sizes before fetching data.
  function* blobs(
    entries: Entry[],
    readContent = true,
  ): Generator<{ entry: Entry; value: string | undefined }> {
    const eligible = entries.filter((entry) => {
      if (excluded(entry.path) || !["100644", "100755"].includes(entry.mode)) {
        omit(entry.path);
        return false;
      }
      return true;
    });
    const invalid = () =>
      new Problem(422, "Could not read captured Git objects");
    const batchSize = readContent ? 64 : 1024;
    for (let offset = 0; offset < eligible.length; offset += batchSize) {
      const batch = eligible.slice(offset, offset + batchSize);
      const checks = git(
        ["cat-file", "--batch-check"],
        batch.length * 128,
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
          omit(entry.path);
          return false;
        }
        return true;
      });
      if (!selected.length) continue;
      if (!readContent) {
        for (const entry of selected) yield { entry, value: undefined };
        continue;
      }
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
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const changedPaths = new Set(changes);
  // Context capture reads metadata only. Binary detection is deferred until
  // first access, so unchanged content cannot create unbounded synchronous IO.
  let contextCount = 0;
  for (const { entry } of blobs(
    entries.filter((e) => !changedPaths.has(e.path)),
    false,
  )) {
    if (++contextCount > MAX_CONTEXT_FILES)
      throw new Problem(
        413,
        "Snapshot reviews support up to 20,000 context references",
      );
    context[entry.path] = entry.hash;
  }
  const inlineEntries = entries.filter((e) => changedPaths.has(e.path));
  const captured =
    scope === "uncommitted"
      ? inlineEntries.map((entry) => ({
          entry,
          value: undefined as string | undefined,
        }))
      : blobs(inlineEntries);
  for (const { entry: e, value: blob } of captured) {
    if (excluded(e.path) || !["100644", "100755"].includes(e.mode)) {
      omit(e.path);
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
          omit(e.path);
          continue;
        }
        if (lstatSync(path).size > MAX_FILE) {
          omit(e.path);
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
    const content = text(value!, entry.path);
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
    context,
    changed: selected,
    omitted: [...omitted].sort(),
  };
}
