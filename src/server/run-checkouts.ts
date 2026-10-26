import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, id, now } from "./db.js";
import type { Run } from "./queue.js";
export type {
  CheckoutFile,
  CheckoutStat,
  CheckoutRemote,
  CheckoutSummary,
} from "../shared/checkout.js";
import {
  checkoutLine,
  type CheckoutFile,
  type CheckoutStat,
  type CheckoutRemote,
  type CheckoutSummary,
} from "../shared/checkout.js";
export { checkoutLine };

/**
 * A run's checkout record: what Loop itself observed in the agent's worktree
 * when the run started and when it ended. It is evidence captured with
 * read-only Git, not activity the harness reported. Loop never commits,
 * pushes, fetches or reverts here, and never runs a command the repository's
 * own configuration asks for.
 *
 * Attribution is an interval, not a claim of exclusive authorship: the
 * worktree belongs to the agent, not the conversation, so another run of the
 * same agent can touch it while this one works. Overlapping runs are recorded.
 *
 * Every Git call is asynchronous: the worker that captures also drives native
 * sessions, and a slow status or diff must not stall them.
 */

/** Stored patches stop at this many bytes, on a line boundary. */
export const PATCH_LIMIT = 300 * 1024;
const GIT_TIMEOUT_MS = 30000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const TERMINAL_STATES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
];
const ACTIVE_STATES = ["running", "pausing", "paused", "awaiting_approval"];

export class CheckoutError extends Error {}

export type CheckoutRow = {
  id: string;
  owner_id: string;
  run_id: string;
  agent_id: string;
  conversation_id: string;
  generation: string | null;
  directory: string;
  source: string;
  branch: string;
  base_ref: string | null;
  base_sha: string | null;
  start_head: string;
  start_patch: string | null;
  start_untracked_paths: string | null;
  start_dirty: number;
  start_untracked: number;
  started_at: number;
  state: "started" | "captured" | "failed";
  end_head: string | null;
  ahead: number | null;
  behind: number | null;
  files: string | null;
  committed: string | null;
  working: string | null;
  untracked: string | null;
  patch: string | null;
  patch_bytes: number | null;
  patch_truncated: number | null;
  remote: string | null;
  overlap: string | null;
  captured_late: number;
  capture_token: string | null;
  capture_started_at: number | null;
  capture_pending: number;
  summary: string | null;
  ended_at: number | null;
  error: string | null;
};
export type CheckoutDetail = Omit<
  CheckoutRow,
  | "files"
  | "committed"
  | "working"
  | "untracked"
  | "remote"
  | "overlap"
  | "summary"
  | "patch_truncated"
  | "captured_late"
  | "capture_token"
  | "capture_started_at"
  | "capture_pending"
  | "start_patch"
  | "start_untracked_paths"
> & {
  files: CheckoutFile[];
  committed: CheckoutStat | null;
  working: CheckoutStat | null;
  untracked: string[];
  remote: CheckoutRemote | null;
  overlap: string[];
  patch_truncated: boolean;
  captured_late: boolean;
  summary: CheckoutSummary | null;
};

type GitResult = {
  ok: boolean;
  code: number | null;
  out: string;
  truncated: boolean;
};
/**
 * Where a capture command reads its repository state from. Commands that
 * inspect the working tree run against an isolated Git directory that Loop
 * owns: a minimal configuration, a copy of the checkout's HEAD, index and
 * refs, and the repository's objects attached through alternates. Nothing a
 * writer can change under the repository's own .git directory (filters, diff
 * drivers, attributes, hooks, promisor remotes, transports) is read while a
 * command runs, and nothing is written back to the repository.
 */
type Iso = { directory: string; env: NodeJS.ProcessEnv; cleanup: () => void };
// Attributes (.gitattributes, text, eol, filter, diff) are read as usual so
// line-ending normalisation still applies; the isolated configuration
// defines no filter or diff driver, so an attribute that names one selects
// nothing that runs. Files whose attributes select a filter are compared as
// raw content and marked as such. The repository's attributes file setting
// is overridden; its info/attributes is not copied.
const SAFE = [
  "-c",
  "core.quotePath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.sshCommand=/bin/false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "diff.external=",
];
// Capture commands see no Git configuration but the isolated directory's:
// the user's global and the system configuration are disabled, so a filter
// or driver defined there (Git LFS installs one globally) cannot be selected
// either, and every inherited GIT_* variable is dropped so no override or
// alternative configuration source reaches the command.
const SAFE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_SSH_COMMAND: "/bin/false",
  GIT_ASKPASS: "/bin/false",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("GIT_")) env[key] = value;
  return env;
}
const IGNORE_SUBMODULES = "--ignore-submodules=all";
function git(
  where: Iso,
  args: string[],
  cap = OUTPUT_LIMIT,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", where.directory, ...SAFE, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...sanitizedEnv(), ...SAFE_ENV, ...where.env },
    });
    const chunks: Buffer[] = [];
    let size = 0,
      truncated = false,
      settled = false;
    const finish = (ok: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        code,
        out: Buffer.concat(chunks).toString("utf8"),
        truncated,
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, null);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (size + chunk.length > cap) {
        chunks.push(chunk.subarray(0, cap - size));
        size = cap;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on("error", () => finish(false, null));
    child.on("close", (code) =>
      finish(!truncated && code === 0, truncated ? null : code),
    );
  });
}
async function must(where: Iso, args: string[]) {
  const result = await git(where, args);
  if (!result.ok)
    throw new CheckoutError(`git ${args[0]} failed in the agent worktree`);
  return result.out.trim();
}
async function maybe(where: Iso, args: string[]) {
  const result = await git(where, args);
  return result.ok ? result.out.trim() : null;
}
/** Commands that only read refs (rev-parse, symbolic-ref) run no drivers. */
const plain = (directory: string): Iso => ({
  directory,
  env: {},
  cleanup: () => {},
});

function globalSettings(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["config", "--global", "--list", "-z"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.on(
      "data",
      (chunk: Buffer) => chunks.length < 4096 && chunks.push(chunk),
    );
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : "");
    });
  });
}

/**
 * Build the isolated Git directory for a checkout. Only the object format
 * extension is carried over; a partial clone's promisor remote is not, so a
 * missing object fails the command instead of fetching. Reftable
 * repositories are not supported.
 */
async function isolate(directory: string): Promise<Iso> {
  const here = plain(directory);
  const common = await must(here, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const own = await must(here, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  const top = await must(here, ["rev-parse", "--show-toplevel"]);
  const branch = await maybe(here, [
    "symbolic-ref",
    "--short",
    "--quiet",
    "HEAD",
  ]);
  // The user's global settings first, then the repository's, then the
  // worktree's, so a later scope replaces an earlier one. Only allowlisted
  // keys are carried; the global listing is read with the user's own
  // environment, since the capture environment hides it.
  const settings = [
    await globalSettings(),
    // --includes follows include.path and includeIf, so a setting supplied
    // through an included file is seen; only allowlisted keys are carried.
    (await maybe(here, [
      "config",
      "--file",
      join(common, "config"),
      "--includes",
      "--list",
      "-z",
    ])) ?? "",
    (await maybe(here, [
      "config",
      "--file",
      join(own, "config.worktree"),
      "--includes",
      "--list",
      "-z",
    ])) ?? "",
  ].join("\0");
  const config = ["[core]", "\trepositoryformatversion = 0", "\tbare = false"];
  // Carried over: the object format, and the tracking configuration that
  // resolves @{upstream} to a remote-tracking ref (never a URL, transport,
  // credential or promisor setting, so no fetch can happen).
  const carried = new Map<string, string>();

  const tracking = branch
    ? new RegExp(
        `^(?:branch\\.${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:remote|merge|pushremote)|remote\\.[^=]+\\.fetch)$`,
      )
    : null;
  // Settings that decide how worktree content compares with the index. They
  // are plain values, never commands; without them a CRLF file could read
  // as changed when the repository normalises line endings.
  const comparison =
    /^core\.(?:autocrlf|eol|ignorecase|filemode|symlinks|precomposeunicode|whitespace|safecrlf|excludesfile)$/;
  for (const entry of settings.split("\0")) {
    const split = entry.indexOf("\n");
    if (split < 0) continue;
    const key = entry.slice(0, split),
      value = entry.slice(split + 1);
    if (key === "extensions.refstorage")
      throw new CheckoutError(
        "Checkout capture does not support reftable repositories",
      );
    if (
      key === "extensions.objectformat" ||
      key === "extensions.compatobjectformat"
    ) {
      config[1] = "\trepositoryformatversion = 1";
      carried.set(key, value);
    } else if (tracking?.test(key) || comparison.test(key))
      carried.set(key, value);
  }
  const gitDir = await mkdtemp(join(tmpdir(), "loop-checkout-"));
  const cleanup = () => {
    void rm(gitDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(
      join(gitDir, "objects", "info", "alternates"),
      join(common, "objects") + "\n",
    );
    await writeFile(join(gitDir, "config"), config.join("\n") + "\n");
    const settingsFile = plain(gitDir);
    for (const [key, value] of carried)
      await must(settingsFile, [
        "config",
        "--file",
        join(gitDir, "config"),
        "--replace-all",
        key,
        value,
      ]);
    await copyFile(join(own, "HEAD"), join(gitDir, "HEAD"));
    // The index and, for a split index, the shared part it refers to.
    for (const name of await readdir(own).catch(() => [] as string[]))
      if (name === "index" || name.startsWith("sharedindex."))
        await copyFile(join(own, name), join(gitDir, name));
    await cp(join(common, "refs"), join(gitDir, "refs"), {
      recursive: true,
    }).catch(() => mkdir(join(gitDir, "refs")));
    await copyFile(
      join(common, "packed-refs"),
      join(gitDir, "packed-refs"),
    ).catch(() => {});
    // A shallow clone's history boundary, so walks stop where Git's do.
    await copyFile(join(common, "shallow"), join(gitDir, "shallow")).catch(
      () => {},
    );
    // Repository-local exclusions, so ignored build output stays ignored.
    await mkdir(join(gitDir, "info"));
    await copyFile(
      join(common, "info", "exclude"),
      join(gitDir, "info", "exclude"),
    ).catch(() => {});
  } catch (error) {
    cleanup();
    throw error instanceof CheckoutError
      ? error
      : new CheckoutError(
          "Checkout capture could not prepare an isolated Git directory",
        );
  }
  return {
    directory,
    env: { GIT_DIR: gitDir, GIT_WORK_TREE: top },
    cleanup,
  };
}

async function status(where: Iso) {
  // Porcelain v1, NUL-terminated: "XY path\0" with a second "orig\0" for renames.
  const out = await must(where, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    IGNORE_SUBMODULES,
  ]);
  const entries = out.split("\0");
  const tracked: string[] = [],
    untracked: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2),
      path = entry.slice(3);
    if (code === "??") untracked.push(path);
    else {
      tracked.push(path);
      if (
        code[0] === "R" ||
        code[0] === "C" ||
        code[1] === "R" ||
        code[1] === "C"
      )
        i++;
    }
  }
  return { tracked, untracked };
}

const DIFF = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  IGNORE_SUBMODULES,
];
async function numstat(where: Iso, range: string[]): Promise<CheckoutStat> {
  const out = await must(where, [...DIFF, "--numstat", "-z", ...range]);
  const parts = out.split("\0");
  const files: CheckoutFile[] = [];
  let additions = 0,
    deletions = 0;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    // "added<TAB>deleted<TAB>path": only the first two tabs separate fields;
    // a path keeps any tab of its own in the NUL-terminated format.
    const first = line.indexOf("\t"),
      second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const add = line.slice(0, first),
      del = line.slice(first + 1, second);
    let path = line.slice(second + 1);
    // A rename has an empty path in the numstat record and two NUL-terminated
    // paths after it: the old one and the new one.
    if (!path) {
      i++;
      path = parts[++i] ?? "";
    }
    const binary = add === "-" || del === "-";
    const a = binary ? 0 : Number(add),
      d = binary ? 0 : Number(del);
    additions += a;
    deletions += d;
    files.push({ path, additions: a, deletions: d, binary });
  }
  return { files, additions, deletions };
}

/** Paths whose attributes select a filter: compared as raw content here. */
async function filtered(where: Iso, paths: string[]) {
  if (!paths.length) return new Set<string>();
  const out = await maybe(where, [
    "check-attr",
    "-z",
    "filter",
    "--",
    ...paths,
  ]);
  const parts = (out ?? "").split("\0");
  const result = new Set<string>();
  // "path\0attribute\0value\0" triples.
  for (let i = 0; i + 2 < parts.length; i += 3)
    if (parts[i + 2] !== "unspecified" && parts[i + 2] !== "unset")
      result.add(parts[i]);
  return result;
}

async function patch(where: Iso, base: string) {
  const result = await git(where, [...DIFF, base, "--"], PATCH_LIMIT * 4);
  if (!result.ok && !result.truncated)
    throw new CheckoutError("git diff failed in the agent worktree");
  const full = Buffer.byteLength(result.out, "utf8");
  if (result.truncated || full > PATCH_LIMIT) {
    let text = Buffer.from(result.out, "utf8")
      .subarray(0, PATCH_LIMIT)
      .toString("utf8");
    const cut = text.lastIndexOf("\n");
    if (cut > 0) text = text.slice(0, cut + 1);
    return {
      patch: text,
      bytes: result.truncated ? null : full,
      truncated: true,
    };
  }
  return { patch: result.out, bytes: full, truncated: false };
}

/** Rebuild the saved tracked state entirely inside our disposable Git directory. */
async function runBase(where: Iso, row: CheckoutRow) {
  if (!row.start_patch) return row.start_head;
  const gitDir = where.env.GIT_DIR!;
  const snapshot = {
    ...where,
    env: { ...where.env, GIT_INDEX_FILE: join(gitDir, "run-start.index") },
  };
  const patchFile = join(gitDir, "run-start.patch");
  await writeFile(patchFile, row.start_patch, { mode: 0o600 });
  await must(snapshot, ["read-tree", row.start_head]);
  await must(snapshot, [
    "apply",
    "--cached",
    "--binary",
    "--whitespace=nowarn",
    "--",
    patchFile,
  ]);
  return must(snapshot, ["write-tree"]);
}

async function remote(
  where: Iso,
  branch: string,
  head: string,
): Promise<CheckoutRemote | null> {
  // The upstream when one is set, otherwise the conventional origin ref, and
  // only a remote-tracking ref: an upstream on "." is a local branch and
  // says nothing about any remote. Only local remote-tracking refs are
  // read; nothing contacts the network, so the observation is as fresh as
  // the last fetch, and says so by its timestamp.
  const upstream = await maybe(where, [
    "rev-parse",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const ref = upstream?.startsWith("refs/remotes/")
    ? upstream
    : (await maybe(where, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${branch}`,
        ]))
      ? `refs/remotes/origin/${branch}`
      : null;
  if (!ref) return null;
  const sha = await maybe(where, ["rev-parse", "--verify", "--quiet", ref]);
  if (!sha) return null;
  // Exit 0 means the remote ref contains HEAD, 1 that it does not; anything
  // else (a missing object, a timeout) is not an answer.
  const ancestry = await git(where, ["merge-base", "--is-ancestor", head, sha]);
  const contains =
    ancestry.code === 0 ? true : ancestry.code === 1 ? false : null;
  return { ref, sha, contains_head: contains, observed_at: now() };
}

function summarize(row: CheckoutRow): CheckoutSummary {
  const files = row.files ? (JSON.parse(row.files) as CheckoutFile[]) : [];
  const untracked = row.untracked
    ? (JSON.parse(row.untracked) as string[])
    : [];
  const seen = row.remote ? (JSON.parse(row.remote) as CheckoutRemote) : null;
  return {
    id: row.id,
    state: row.state,
    ...(row.start_patch != null ? { scope: "run" as const } : {}),
    branch: row.branch,
    base_ref: row.base_ref,
    ahead: row.ahead ?? null,
    behind: row.behind ?? null,
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    untracked: untracked.length,
    remote: !seen
      ? "none"
      : seen.contains_head === null
        ? "unknown"
        : seen.contains_head
          ? "contains"
          : "missing",
    started_dirty: !!row.start_dirty || !!row.start_untracked,
    overlap: row.overlap ? (JSON.parse(row.overlap) as string[]).length : 0,
    late: !!row.captured_late,
    error: row.error,
  };
}

function select(runId: string, owner?: string) {
  return db
    .prepare(
      `SELECT * FROM run_checkouts WHERE run_id=?${owner ? " AND owner_id=?" : ""}`,
    )
    .get(...(owner ? [runId, owner] : [runId])) as CheckoutRow | undefined;
}

export function toDetail(row: CheckoutRow): CheckoutDetail {
  // The baseline is capture machinery, not another browser-visible patch.
  const { start_patch, start_untracked_paths, ...detail } = row;
  return {
    ...detail,
    files: row.files ? JSON.parse(row.files) : [],
    committed: row.committed ? JSON.parse(row.committed) : null,
    working: row.working ? JSON.parse(row.working) : null,
    untracked: row.untracked ? JSON.parse(row.untracked) : [],
    remote: row.remote ? JSON.parse(row.remote) : null,
    overlap: row.overlap ? JSON.parse(row.overlap) : [],
    patch_truncated: !!row.patch_truncated,
    captured_late: !!row.captured_late,
    summary: row.summary ? JSON.parse(row.summary) : null,
  };
}

/** The checkout record of one run, for its owner. */
export function checkoutDetail(
  owner: string,
  runId: string,
): CheckoutDetail | null {
  const row = select(runId, owner);
  return row ? toDetail(row) : null;
}
/** The card summary, as stored JSON, for feed and thread projections. */
export function checkoutSummary(
  owner: string,
  runId: string,
): CheckoutSummary | null {
  const row = db
    .prepare("SELECT summary FROM run_checkouts WHERE run_id=? AND owner_id=?")
    .get(runId, owner) as { summary: string | null } | undefined;
  return row?.summary ? (JSON.parse(row.summary) as CheckoutSummary) : null;
}
// Prepared on first use: this module is loaded by the queue, which some
// fixtures import against databases that have not run every migration.
const INSERT = () =>
  db.prepare(
    `INSERT OR IGNORE INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,generation,directory,source,branch,base_ref,base_sha,start_head,start_patch,start_untracked_paths,start_dirty,start_untracked,started_at,state,error,summary)
   VALUES(@id,@owner_id,@run_id,@agent_id,@conversation_id,@generation,@directory,@source,@branch,@base_ref,@base_sha,@start_head,@start_patch,@start_untracked_paths,@start_dirty,@start_untracked,@started_at,@state,@error,@summary)`,
  );

/** The start capture's overall budget: it runs before the agent is dispatched. */
const START_BUDGET_MS = 20000;
/**
 * Record the checkout as the run begins. A run that resumes (after an
 * approval or an interruption) keeps its first start record. Never throws:
 * a capture failure is recorded on the run, not raised into its launch.
 */
export async function startCheckout(
  run: Run,
  directory: string,
  source: string,
  generation: string | null,
) {
  if (!run.agent_id || !run.conversation_id) return;
  if (select(run.id)) return;
  const time = now();
  const base = {
    id: id(),
    owner_id: run.owner_id,
    run_id: run.id,
    agent_id: run.agent_id,
    conversation_id: run.conversation_id,
    generation,
    directory,
    source,
    started_at: time,
    captured_late: 0,
  };
  let row: CheckoutRow;
  let iso: Iso | undefined;
  let budgetPassed = false;
  // The start capture precedes dispatch, so it has an overall budget; a
  // slow repository records a failed start rather than delaying the agent.
  // The task keeps running after the budget passes and then cleans up its
  // own isolated directory, so nothing is leaked either way.
  const task = (async () => {
    try {
      iso = await isolate(directory);
      const branch =
        (await maybe(iso, ["symbolic-ref", "--short", "--quiet", "HEAD"])) ??
        "HEAD";
      const head = await must(iso, ["rev-parse", "--verify", "HEAD"]);
      const { tracked, untracked } = await status(iso);
      // Unlike the display patch this must be complete: never pretend a
      // shortened baseline can establish which edits happened in this run.
      const baseline = await git(iso, [
        ...DIFF,
        "--binary",
        "--full-index",
        "--no-renames",
        head,
        "--",
      ]);
      if (!baseline.ok)
        throw new CheckoutError(
          "Could not capture the complete run baseline (maximum 4 MB)",
        );
      return { branch, head, startPatch: baseline.out, tracked, untracked };
    } finally {
      if (budgetPassed) iso?.cleanup();
    }
  })();
  task.catch(() => {});
  let budget: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        budget = setTimeout(() => {
          budgetPassed = true;
          reject(
            new CheckoutError(
              `Checkout capture exceeded its ${START_BUDGET_MS / 1000} second budget`,
            ),
          );
        }, START_BUDGET_MS);
      }),
    ]);
    const { branch, head, startPatch, tracked, untracked } = observed;
    row = {
      ...base,
      branch,
      base_ref: "run start",
      base_sha: head,
      start_head: head,
      start_patch: startPatch,
      start_untracked_paths: JSON.stringify(untracked),
      start_dirty: tracked.length ? 1 : 0,
      start_untracked: untracked.length ? 1 : 0,
      state: "started",
      error: null,
    } as CheckoutRow;
  } catch (error) {
    row = {
      ...base,
      branch: "HEAD",
      base_ref: null,
      base_sha: null,
      start_head: "",
      start_patch: null,
      start_untracked_paths: null,
      start_dirty: 0,
      start_untracked: 0,
      state: "failed",
      error:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Checkout capture failed",
    } as CheckoutRow;
  } finally {
    clearTimeout(budget);
    if (!budgetPassed) iso?.cleanup();
  }
  // The run may have been recorded by a concurrent start while Git ran.
  INSERT().run({ ...row, summary: JSON.stringify(summarize(row)) });
}

const CAPTURE_FIELDS = [
  "end_head",
  "ahead",
  "behind",
  "files",
  "committed",
  "working",
  "untracked",
  "patch",
  "patch_bytes",
  "patch_truncated",
  "remote",
  "overlap",
] as const;
const UPDATE = () =>
  db.prepare(
    `UPDATE run_checkouts SET id=@id,state=@state,branch=@branch,base_sha=@base_sha,${CAPTURE_FIELDS.map((f) => `${f}=@${f}`).join(",")},captured_late=@captured_late,summary=@summary,ended_at=@ended_at,error=@error WHERE run_id=@run_id AND capture_token=@token`,
  );

/**
 * Capture the end state when a run reaches a terminal state. A run that ends
 * more than once (interrupted, then resumed and completed) is recaptured, so
 * the record describes the checkout at its latest end. A failed capture
 * clears the capture fields rather than leaving an older observation under a
 * new timestamp. Never throws.
 */
/** A capture that has run longer than this is treated as abandoned. */
const CAPTURE_LEASE_MS = 120000;
export async function completeCheckout(
  runId: string,
  options: { late?: boolean; ifIdle?: boolean } = {},
) {
  const row = select(runId);
  if (!row) return;
  if (row.state === "failed" && !row.start_head) {
    // Nothing to observe for a run whose start was never captured; drop the
    // request so reconciliation does not keep selecting it.
    db.prepare("UPDATE run_checkouts SET capture_pending=0 WHERE run_id=?").run(
      runId,
    );
    return;
  }
  const time = now();
  // One capture per run at a time, across processes: a terminal transition
  // in the API process and the worker's reconciliation can both arrive. A
  // later request while one is in flight asks the holder to run again, so
  // the record always ends on the latest observation.
  const token = id();
  // Claim and read in one statement: the row this capture archives and
  // updates is the row as it was when the claim succeeded, never an earlier
  // read that another process has since replaced.
  const claimed = db
    .prepare(
      "UPDATE run_checkouts SET capture_token=?,capture_started_at=?,capture_pending=0 WHERE run_id=? AND (capture_token IS NULL OR capture_started_at<?) RETURNING *",
    )
    .get(token, time, runId, time - CAPTURE_LEASE_MS) as
    CheckoutRow | undefined;
  if (!claimed) {
    if (!options.ifIdle)
      db.prepare(
        "UPDATE run_checkouts SET capture_pending=1 WHERE run_id=?",
      ).run(runId);
    return;
  }
  return captureClaimed(claimed, token, time, options);
}

async function captureClaimed(
  row: CheckoutRow,
  token: string,
  time: number,
  options: { late?: boolean; ifIdle?: boolean },
): Promise<void> {
  const runId = row.run_id;
  const fields: Partial<CheckoutRow> = {
    ended_at: time,
    error: null,
    captured_late: options.late ? 1 : 0,
    end_head: null,
    ahead: null,
    behind: null,
  };
  let iso: Iso | undefined;
  try {
    iso = await isolate(row.directory);
    const directory: Iso = iso;
    // One HEAD for the whole capture: another run on this checkout may
    // commit between commands, so every commit-relative query names this
    // SHA rather than resolving the symbolic HEAD again.
    const head = await must(directory, ["rev-parse", "--verify", "HEAD"]);
    const branch =
      (await maybe(directory, [
        "symbolic-ref",
        "--short",
        "--quiet",
        "HEAD",
      ])) ?? row.branch;
    const runScoped = row.start_patch != null;
    const sourceHead = runScoped
      ? row.start_head
      : await maybe(plain(row.source), ["rev-parse", "--verify", "HEAD"]);
    const base = runScoped
      ? row.start_head
      : sourceHead
        ? ((await maybe(directory, ["merge-base", head, sourceHead])) ??
          row.base_sha)
        : row.base_sha;
    const diffBase = runScoped ? await runBase(directory, row) : (base ?? head);
    fields.end_head = head;
    fields.branch = branch;
    fields.base_sha = base;
    if (sourceHead) {
      const counts = await maybe(directory, [
        "rev-list",
        "--left-right",
        "--count",
        `${sourceHead}...${head}`,
      ]);
      const [behind, ahead] = (counts ?? "").split(/\s+/).map(Number);
      if (Number.isFinite(ahead) && Number.isFinite(behind)) {
        fields.ahead = ahead;
        fields.behind = behind;
      }
    }
    const { untracked, tracked } = await status(directory);
    const initialUntracked = new Set<string>(
      JSON.parse(row.start_untracked_paths ?? "[]"),
    );
    fields.untracked = JSON.stringify(
      untracked.filter((path) => !initialUntracked.has(path)),
    );
    const working = await numstat(directory, [head, "--"]);
    const committed = base
      ? await numstat(directory, [base, head, "--"])
      : null;
    const files = (await numstat(directory, [diffBase, "--"])).files;
    const raw = await filtered(directory, [
      ...new Set(
        [...working.files, ...(committed?.files ?? []), ...files].map(
          (f) => f.path,
        ),
      ),
    ]);
    for (const file of working.files)
      if (raw.has(file.path)) file.filtered = true;
    fields.working = JSON.stringify(working);
    if (base) {
      for (const file of committed!.files)
        if (raw.has(file.path)) file.filtered = true;
      fields.committed = JSON.stringify(committed);
      for (const file of files) if (raw.has(file.path)) file.filtered = true;
      fields.files = JSON.stringify(files);
    } else {
      // No shared base with the source: show the working tree against HEAD
      // and say so through the missing base.
      fields.committed = null;
      fields.files = JSON.stringify(working.files);
    }
    const p = await patch(directory, diffBase);
    fields.patch = p.patch;
    fields.patch_bytes = p.bytes;
    fields.patch_truncated = p.truncated ? 1 : 0;
    const seen = await remote(directory, branch, head);
    fields.remote = seen ? JSON.stringify(seen) : null;
    // Include the source-reading window, not just the capture's start: a
    // sibling may begin and commit while isolate is copying the refs.
    // Any sibling still active or ended after this run started is ambiguous.
    fields.overlap = JSON.stringify(
      (
        db
          .prepare(
            `SELECT r.id FROM runs r JOIN companion_sessions s ON s.conversation_id=r.conversation_id
             WHERE r.owner_id=? AND s.project=? AND r.id<>? AND r.state<>'queued' AND r.created_at<=?
               AND (r.updated_at>=? OR r.state IN (${ACTIVE_STATES.map(() => "?").join(",")}))
             ORDER BY r.created_at`,
          )
          .all(
            row.owner_id,
            row.directory,
            row.run_id,
            now(),
            row.started_at,
            ...ACTIVE_STATES,
          ) as { id: string }[]
      ).map((r) => r.id),
    );
    fields.state = "captured";
  } catch (error) {
    for (const field of CAPTURE_FIELDS) fields[field] = null as never;
    fields.base_sha = row.base_sha;
    fields.state = "failed";
    fields.error =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Checkout capture failed";
  } finally {
    iso?.cleanup();
  }
  const next = { ...row, ...fields } as CheckoutRow;
  if (row.ended_at !== null) next.id = id();
  next.summary = JSON.stringify(summarize(next));
  // Write, release and notify together: a process exit leaves either the
  // whole observation with its change events or nothing of it.
  const outcome = db
    .transaction(() => {
      const written = UPDATE().run({
        run_id: row.run_id,
        token,
        id: next.id,
        state: next.state,
        branch: next.branch,
        base_sha: next.base_sha ?? null,
        ...Object.fromEntries(CAPTURE_FIELDS.map((f) => [f, next[f] ?? null])),
        captured_late: next.captured_late,
        summary: next.summary,
        ended_at: next.ended_at ?? null,
        error: next.error ?? null,
      }).changes;
      // The lease passed to another capture while this one ran: its result
      // is discarded, and the holder will publish its own.
      if (!written) return "lost";
      const release = db
        .prepare(
          "UPDATE run_checkouts SET capture_token=NULL,capture_started_at=NULL WHERE run_id=? AND capture_token=? RETURNING capture_pending",
        )
        .get(runId, token) as { capture_pending: number } | undefined;
      if (release?.capture_pending) return "again";
      return "done";
    })
    .immediate();
  if (outcome === "again") return completeCheckout(runId);
}

/** Runs are considered to have ended while the host was down after this long. */
const LATE_AFTER_MS = 60000;
const RECONCILE_EVERY_MS = 30000;
let reconciling: Promise<void> | null = null;
let reconciledAt = 0;
/**
 * Runs that ended without a capture, because the process stopped between the
 * terminal transition and the capture or because recovery marked them
 * interrupted directly. Runs in the background beside dispatch, never
 * gating it, and skips any run whose capture is already in flight.
 */
export function reconcileCheckouts(): Promise<void> {
  if (reconciling) return reconciling;
  if (now() - reconciledAt < RECONCILE_EVERY_MS) return Promise.resolve();
  reconciledAt = now();
  reconciling = (async () => {
    const time = now();
    const pending = db
      .prepare(
        `SELECT k.run_id,r.updated_at FROM run_checkouts k JOIN runs r ON r.id=k.run_id
         WHERE k.start_head<>'' AND (k.state='started' OR k.capture_pending=1 OR k.capture_token IS NOT NULL)
           AND (k.capture_token IS NULL OR k.capture_started_at<?)
           AND r.state IN (${TERMINAL_STATES.map(() => "?").join(",")}) LIMIT 20`,
      )
      .all(time - CAPTURE_LEASE_MS, ...TERMINAL_STATES) as {
      run_id: string;
      updated_at: number;
    }[];
    for (const { run_id, updated_at } of pending)
      await completeCheckout(run_id, {
        late: time - updated_at > LATE_AFTER_MS,
        ifIdle: true,
      });
  })().finally(() => {
    reconciling = null;
  });
  return reconciling;
}
