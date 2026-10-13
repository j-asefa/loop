import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { db, id, now } from "./db.js";
import { recordChange } from "./project-changes.js";
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
export const TERMINAL_STATES = ["completed", "failed", "interrupted", "cancelled"];
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

type GitResult = { ok: boolean; out: string; truncated: boolean };
// Configuration that would make Git run a command during capture is
// overridden on the command line; diffs also refuse external and text
// conversion drivers explicitly. Filters have no override, so capture
// refuses repositories whose own configuration defines them (below).
/** Git's well-known empty tree: an attribute source that selects nothing. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Attributes are read from the empty tree rather than the worktree, so no
// .gitattributes can select a filter, diff driver or text conversion, and
// the attributes file setting is overridden. That holds inside each Git
// command, whatever the repository configuration says at the time. Only
// $GIT_DIR/info/attributes is outside these controls; the guard below
// refuses a repository that uses it to select drivers.
const SAFE = [
  "-c", "core.quotePath=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "submodule.recurse=false",
  "-c", "diff.external=",
];
const IGNORE_SUBMODULES = "--ignore-submodules=all";
function git(directory: string, args: string[], cap = OUTPUT_LIMIT): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", directory, ...SAFE, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_SOURCE: EMPTY_TREE },
    });
    const chunks: Buffer[] = [];
    let size = 0,
      truncated = false,
      settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, out: Buffer.concat(chunks).toString("utf8"), truncated });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
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
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(truncated ? false : code === 0));
  });
}
async function must(directory: string, args: string[]) {
  const result = await git(directory, args);
  if (!result.ok)
    throw new CheckoutError(`git ${args[0]} failed in the agent worktree`);
  return result.out.trim();
}
async function maybe(directory: string, args: string[]) {
  const result = await git(directory, args);
  return result.ok ? result.out.trim() : null;
}

// Keys whose values Git executes while diffing or inspecting a working tree.
const COMMAND_KEYS =
  /^(?:filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|diff\.external|core\.fsmonitor|core\.attributesfile)$/i;
const DRIVER_ATTRIBUTES = /(?:^|\s)(?:filter|diff)=/m;
const REPOSITORY_SCOPES = new Set(["local", "worktree"]);
const SCOPES = new Set(["system", "global", "local", "worktree", "command", "unknown"]);
/**
 * The repository's own configuration files are agent-adjacent: refuse to
 * capture when they define filters or diff drivers, since Git would run those
 * commands with Loop's privileges and outside the harness's approval flow.
 * User and system configuration are the owner's and are not inspected.
 */
async function refuseCommandConfig(directory: string) {
  // The resolved configuration with each key's scope: includes are listed
  // under the scope of the file that included them, so a filter defined in
  // a file the repository config pulls in still shows as repository scope.
  const listed = await must(directory, ["config", "--list", "-z", "--name-only", "--show-scope"]);
  const tokens = listed.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    let scope = tokens[i],
      key = "";
    const inline = /^(system|global|local|worktree|command|unknown)[\t\n](.+)$/s.exec(scope);
    if (inline) [scope, key] = [inline[1], inline[2]];
    else if (SCOPES.has(scope)) key = tokens[++i] ?? "";
    else continue;
    if (REPOSITORY_SCOPES.has(scope) && COMMAND_KEYS.test(key))
      throw new CheckoutError(
        `The repository configuration defines ${key}, which Git would run during capture; Loop does not run it.`,
      );
  }
  // In-tree attributes are bypassed by the empty attribute source; the
  // repository's info/attributes files are not, so they must not select
  // drivers either.
  const common = await must(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const own = await must(directory, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  for (const file of new Set([common + "/info/attributes", own + "/info/attributes"])) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (DRIVER_ATTRIBUTES.test(text.replace(/#.*$/gm, "")))
      throw new CheckoutError(
        `${file} selects a filter or diff driver, which Git would run during capture; Loop does not run it.`,
      );
  }
}

async function status(directory: string) {
  // Porcelain v1, NUL-terminated: "XY path\0" with a second "orig\0" for renames.
  const out = await must(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", IGNORE_SUBMODULES]);
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
      if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i++;
    }
  }
  return { tracked, untracked };
}

const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", IGNORE_SUBMODULES];
async function numstat(directory: string, range: string[]): Promise<CheckoutStat> {
  const out = await must(directory, [...DIFF, "--numstat", "-z", ...range]);
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

async function patch(directory: string, base: string) {
  const result = await git(directory, [...DIFF, base, "--"], PATCH_LIMIT * 4);
  if (!result.ok && !result.truncated)
    throw new CheckoutError("git diff failed in the agent worktree");
  const full = Buffer.byteLength(result.out, "utf8");
  if (result.truncated || full > PATCH_LIMIT) {
    let text = Buffer.from(result.out, "utf8").subarray(0, PATCH_LIMIT).toString("utf8");
    const cut = text.lastIndexOf("\n");
    if (cut > 0) text = text.slice(0, cut + 1);
    return { patch: text, bytes: result.truncated ? null : full, truncated: true };
  }
  return { patch: result.out, bytes: full, truncated: false };
}

async function remote(directory: string, branch: string, head: string): Promise<CheckoutRemote | null> {
  // The upstream when one is set, otherwise the conventional origin ref. Only
  // local remote-tracking refs are read: nothing contacts the network, so the
  // observation is as fresh as the last fetch, and says so by its timestamp.
  const ref =
    (await maybe(directory, ["rev-parse", "--symbolic-full-name", "@{upstream}"])) ??
    ((await maybe(directory, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]))
      ? `refs/remotes/origin/${branch}`
      : null);
  if (!ref) return null;
  const sha = await maybe(directory, ["rev-parse", "--verify", "--quiet", ref]);
  if (!sha) return null;
  const contains = (await git(directory, ["merge-base", "--is-ancestor", head, sha])).ok;
  return { ref, sha, contains_head: contains, observed_at: now() };
}

function summarize(row: CheckoutRow): CheckoutSummary {
  const files = row.files ? (JSON.parse(row.files) as CheckoutFile[]) : [];
  const untracked = row.untracked ? (JSON.parse(row.untracked) as string[]) : [];
  const seen = row.remote ? (JSON.parse(row.remote) as CheckoutRemote) : null;
  return {
    id: row.id,
    state: row.state,
    branch: row.branch,
    base_ref: row.base_ref,
    ahead: row.ahead ?? null,
    behind: row.behind ?? null,
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    untracked: untracked.length,
    remote: !seen ? "none" : seen.contains_head ? "contains" : "missing",
    started_dirty: !!row.start_dirty || !!row.start_untracked,
    overlap: row.overlap ? (JSON.parse(row.overlap) as string[]).length : 0,
    late: !!row.captured_late,
    error: row.error,
  };
}

/** The brief's citable content: the card line and the file list, as text. */
export function checkoutContent(detail: CheckoutDetail) {
  const lines = [
    `Checkout observed by Loop for run ${detail.run_id}.`,
    detail.summary ? checkoutLine(detail.summary) : `${detail.branch} · not captured`,
    `Base ${detail.base_ref ?? "unknown"} at ${detail.base_sha ?? "unknown"}; start HEAD ${detail.start_head || "unknown"}; end HEAD ${detail.end_head ?? "unknown"}.`,
  ];
  if (detail.start_dirty || detail.start_untracked)
    lines.push("The checkout already had changes before this run; this record brackets an interval, not exclusive authorship.");
  if (detail.overlap.length)
    lines.push(`Other runs were active on this checkout during this run: ${detail.overlap.join(", ")}.`);
  if (detail.captured_late)
    lines.push("Captured after a restart, later than the run ended; the checkout may have changed in between.");
  for (const f of detail.files)
    lines.push(f.binary ? `${f.path} (binary)` : `${f.path} +${f.additions} −${f.deletions}`);
  for (const path of detail.untracked) lines.push(`${path} (untracked)`);
  if (detail.patch_truncated) lines.push("The stored patch was shortened.");
  if (detail.error) lines.push(`Capture error: ${detail.error}`);
  return lines.join("\n");
}

const ARCHIVE = () => db.prepare(
  "INSERT OR IGNORE INTO run_checkout_versions(id,owner_id,run_id,ended_at,record) VALUES(?,?,?,?,?)",
);
function select(runId: string, owner?: string) {
  return db
    .prepare(
      `SELECT * FROM run_checkouts WHERE run_id=?${owner ? " AND owner_id=?" : ""}`,
    )
    .get(...(owner ? [runId, owner] : [runId])) as CheckoutRow | undefined;
}

export function toDetail(row: CheckoutRow): CheckoutDetail {
  return {
    ...row,
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
export function checkoutDetail(owner: string, runId: string): CheckoutDetail | null {
  const row = select(runId, owner);
  return row ? toDetail(row) : null;
}
/** The card summary, as stored JSON, for feed and thread projections. */
export function checkoutSummary(owner: string, runId: string): CheckoutSummary | null {
  const row = db
    .prepare("SELECT summary FROM run_checkouts WHERE run_id=? AND owner_id=?")
    .get(runId, owner) as { summary: string | null } | undefined;
  return row?.summary ? (JSON.parse(row.summary) as CheckoutSummary) : null;
}
/** A checkout by citation id: the live record, or an archived observation. */
export function checkoutById(owner: string, checkoutId: string): CheckoutDetail | null {
  const row = db
    .prepare("SELECT * FROM run_checkouts WHERE id=? AND owner_id=?")
    .get(checkoutId, owner) as CheckoutRow | undefined;
  if (row) return toDetail(row);
  const version = db
    .prepare("SELECT record FROM run_checkout_versions WHERE id=? AND owner_id=?")
    .get(checkoutId, owner) as { record: string } | undefined;
  return version ? toDetail(JSON.parse(version.record) as CheckoutRow) : null;
}

// Prepared on first use: this module is loaded by the queue, which some
// fixtures import against databases that have not run every migration.
const INSERT = () => db.prepare(
  `INSERT OR IGNORE INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,generation,directory,source,branch,base_ref,base_sha,start_head,start_dirty,start_untracked,started_at,state,error,summary)
   VALUES(@id,@owner_id,@run_id,@agent_id,@conversation_id,@generation,@directory,@source,@branch,@base_ref,@base_sha,@start_head,@start_dirty,@start_untracked,@started_at,@state,@error,@summary)`,
);

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
  try {
    await refuseCommandConfig(directory);
    const branch = (await maybe(directory, ["symbolic-ref", "--short", "--quiet", "HEAD"])) ?? "HEAD";
    const head = await must(directory, ["rev-parse", "--verify", "HEAD"]);
    const baseRef = await maybe(source, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
    const sourceHead = await maybe(source, ["rev-parse", "--verify", "HEAD"]);
    const baseSha = sourceHead ? await maybe(directory, ["merge-base", "HEAD", sourceHead]) : null;
    const { tracked, untracked } = await status(directory);
    row = {
      ...base,
      branch,
      base_ref: baseRef,
      base_sha: baseSha,
      start_head: head,
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
      start_dirty: 0,
      start_untracked: 0,
      state: "failed",
      error: error instanceof Error ? error.message.slice(0, 500) : "Checkout capture failed",
    } as CheckoutRow;
  }
  // The run may have been recorded by a concurrent start while Git ran.
  INSERT().run({ ...row, summary: JSON.stringify(summarize(row)) });
}

const CAPTURE_FIELDS = [
  "end_head", "ahead", "behind", "files", "committed", "working", "untracked",
  "patch", "patch_bytes", "patch_truncated", "remote", "overlap",
] as const;
const UPDATE = () => db.prepare(
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
  if (!row || (row.state === "failed" && !row.start_head)) return;
  const time = now();
  // One capture per run at a time, across processes: a terminal transition
  // in the API process and the worker's reconciliation can both arrive. A
  // later request while one is in flight asks the holder to run again, so
  // the record always ends on the latest observation.
  const token = id();
  const claimed = db
    .prepare(
      "UPDATE run_checkouts SET capture_token=?,capture_started_at=?,capture_pending=0 WHERE run_id=? AND (capture_token IS NULL OR capture_started_at<?)",
    )
    .run(token, time, runId, time - CAPTURE_LEASE_MS).changes;
  if (!claimed) {
    if (!options.ifIdle)
      db.prepare("UPDATE run_checkouts SET capture_pending=1 WHERE run_id=?").run(runId);
    return;
  }
  const fields: Partial<CheckoutRow> = { ended_at: time, error: null, captured_late: options.late ? 1 : 0 };
  try {
    const directory = row.directory;
    await refuseCommandConfig(directory);
    // One HEAD for the whole capture: another run on this checkout may
    // commit between commands, so every commit-relative query names this
    // SHA rather than resolving the symbolic HEAD again.
    const head = await must(directory, ["rev-parse", "--verify", "HEAD"]);
    const branch = (await maybe(directory, ["symbolic-ref", "--short", "--quiet", "HEAD"])) ?? row.branch;
    const sourceHead = await maybe(row.source, ["rev-parse", "--verify", "HEAD"]);
    const base = sourceHead
      ? ((await maybe(directory, ["merge-base", head, sourceHead])) ?? row.base_sha)
      : row.base_sha;
    fields.end_head = head;
    fields.branch = branch;
    fields.base_sha = base;
    if (sourceHead) {
      const counts = await maybe(directory, ["rev-list", "--left-right", "--count", `${sourceHead}...${head}`]);
      const [behind, ahead] = (counts ?? "").split(/\s+/).map(Number);
      if (Number.isFinite(ahead) && Number.isFinite(behind)) {
        fields.ahead = ahead;
        fields.behind = behind;
      }
    }
    const { untracked } = await status(directory);
    fields.untracked = JSON.stringify(untracked);
    const working = await numstat(directory, [head, "--"]);
    fields.working = JSON.stringify(working);
    if (base) {
      fields.committed = JSON.stringify(await numstat(directory, [base, head, "--"]));
      fields.files = JSON.stringify((await numstat(directory, [base, "--"])).files);
    } else {
      // No shared base with the source: show the working tree against HEAD
      // and say so through the missing base.
      fields.committed = null;
      fields.files = JSON.stringify(working.files);
    }
    const p = await patch(directory, base ?? head);
    fields.patch = p.patch;
    fields.patch_bytes = p.bytes;
    fields.patch_truncated = p.truncated ? 1 : 0;
    const seen = await remote(directory, branch, head);
    fields.remote = seen ? JSON.stringify(seen) : null;
    // Any other run on this checkout that was active at some point during
    // the interval: still active now, or ended after this run started.
    fields.overlap = JSON.stringify(
      (
        db
          .prepare(
            `SELECT r.id FROM runs r JOIN companion_sessions s ON s.conversation_id=r.conversation_id
             WHERE r.owner_id=? AND s.project=? AND r.id<>? AND r.state<>'queued' AND r.created_at<=?
               AND (r.updated_at>=? OR r.state IN (${ACTIVE_STATES.map(() => "?").join(",")}))
             ORDER BY r.created_at`,
          )
          .all(row.owner_id, directory, row.run_id, time, row.started_at, ...ACTIVE_STATES) as { id: string }[]
      ).map((r) => r.id),
    );
    fields.state = "captured";
  } catch (error) {
    for (const field of CAPTURE_FIELDS) fields[field] = null as never;
    fields.base_sha = row.base_sha;
    fields.state = "failed";
    fields.error = error instanceof Error ? error.message.slice(0, 500) : "Checkout capture failed";
  }
  const next = { ...row, ...fields } as CheckoutRow;
  // An earlier observation stays reachable under its own id, so a brief
  // that cited it keeps resolving to what it cited; the live record moves
  // to a new id.
  if (row.ended_at !== null) {
    const archived = { ...row, capture_token: null, capture_started_at: null, capture_pending: 0 };
    ARCHIVE().run(row.id, row.owner_id, row.run_id, row.ended_at, JSON.stringify(archived));
    next.id = id();
  }
  next.summary = JSON.stringify(summarize(next));
  UPDATE().run({
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
  });
  const release = db
    .prepare(
      "UPDATE run_checkouts SET capture_token=NULL,capture_started_at=NULL WHERE run_id=? AND capture_token=? RETURNING capture_pending",
    )
    .get(runId, token) as { capture_pending: number } | undefined;
  if (release?.capture_pending) return completeCheckout(runId);
  // The run's results now carry checkout evidence: record them as changed so
  // a brief that consumed the result before the capture ended sees it.
  for (const { id: artifact } of db
    .prepare(
      "SELECT a.id FROM artifacts a JOIN artifact_publications p ON p.artifact_id=a.id WHERE a.owner_id=? AND a.run_id=? AND a.archived=0",
    )
    .all(row.owner_id, row.run_id) as { id: string }[])
    recordChange(row.owner_id, null, "result", artifact, row.conversation_id);
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
         WHERE (k.state='started' OR k.capture_pending=1 OR k.capture_token IS NOT NULL)
           AND (k.capture_token IS NULL OR k.capture_started_at<?)
           AND r.state IN (${TERMINAL_STATES.map(() => "?").join(",")}) LIMIT 20`,
      )
      .all(time - CAPTURE_LEASE_MS, ...TERMINAL_STATES) as { run_id: string; updated_at: number }[];
    for (const { run_id, updated_at } of pending)
      await completeCheckout(run_id, { late: time - updated_at > LATE_AFTER_MS, ifIdle: true });
  })().finally(() => {
    reconciling = null;
  });
  return reconciling;
}
