import { spawnSync } from "node:child_process";
import { db, id, now } from "./db.js";
import type { Run } from "./queue.js";

/**
 * A run's checkout record: what Loop itself observed in the agent's worktree
 * when the run started and when it ended. It is evidence captured with
 * read-only Git, not activity the harness reported. Loop never commits,
 * pushes, fetches or reverts here.
 *
 * Attribution is an interval, not a claim of exclusive authorship: the
 * worktree belongs to the agent, not the conversation, so another run of the
 * same agent can touch it while this one works. Overlapping runs are recorded.
 */

/** Stored patches stop at this many bytes, on a line boundary. */
export const PATCH_LIMIT = 300 * 1024;
const GIT_TIMEOUT_MS = 30000;

export class CheckoutError extends Error {}

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
> & {
  files: CheckoutFile[];
  committed: CheckoutStat | null;
  working: CheckoutStat | null;
  untracked: string[];
  remote: CheckoutRemote | null;
  overlap: string[];
  patch_truncated: boolean;
  summary: CheckoutSummary | null;
};

type GitResult = { ok: boolean; out: string; truncated: boolean };
function git(directory: string, args: string[], maxBuffer = 1024 * 1024): GitResult {
  const result = spawnSync(
    "git",
    ["-C", directory, "-c", "core.quotePath=false", ...args],
    {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  const truncated =
    !!result.error && (result.error as NodeJS.ErrnoException).code === "ENOBUFS";
  return {
    ok: !result.error && result.status === 0,
    out: typeof result.stdout === "string" ? result.stdout : "",
    truncated,
  };
}
function must(directory: string, args: string[]) {
  const result = git(directory, args);
  if (!result.ok)
    throw new CheckoutError(`git ${args[0]} failed in the agent worktree`);
  return result.out.trim();
}
function maybe(directory: string, args: string[]) {
  const result = git(directory, args);
  return result.ok ? result.out.trim() : null;
}

function status(directory: string) {
  // Porcelain v1, NUL-terminated: "XY path\0" with a second "orig\0" for renames.
  const out = must(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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

function numstat(directory: string, range: string[]): CheckoutStat {
  const out = must(directory, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-color", ...range]);
  const parts = out.split("\0");
  const files: CheckoutFile[] = [];
  let additions = 0,
    deletions = 0;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    const [add, del, inlinePath] = line.split("\t");
    // A rename has an empty path in the numstat record and two NUL-terminated
    // paths after it: the old one and the new one.
    let path = inlinePath;
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

function patch(directory: string, base: string) {
  // Text diff only: binary content shows as "Binary files differ".
  const result = git(
    directory,
    ["diff", "--no-ext-diff", "--no-color", base, "--"],
    PATCH_LIMIT * 4,
  );
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

function remote(directory: string, branch: string): CheckoutRemote | null {
  // The upstream when one is set, otherwise the conventional origin ref. Only
  // local remote-tracking refs are read: nothing contacts the network, so the
  // observation is as fresh as the last fetch, and says so by its timestamp.
  const ref =
    maybe(directory, ["rev-parse", "--symbolic-full-name", "@{upstream}"]) ??
    (maybe(directory, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])
      ? `refs/remotes/origin/${branch}`
      : null);
  if (!ref) return null;
  const sha = maybe(directory, ["rev-parse", "--verify", "--quiet", ref]);
  if (!sha) return null;
  const contains = git(directory, ["merge-base", "--is-ancestor", "HEAD", sha]).ok;
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
    ahead: row.ahead,
    behind: row.behind,
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    untracked: untracked.length,
    remote: !seen ? "none" : seen.contains_head ? "contains" : "missing",
    started_dirty: !!row.start_dirty || !!row.start_untracked,
    overlap: row.overlap ? (JSON.parse(row.overlap) as string[]).length : 0,
    error: row.error,
  };
}

export function checkoutContent(detail: CheckoutDetail) {
  const lines = [
    `Checkout observed by Loop for run ${detail.run_id}.`,
    detail.summary ? checkoutLine(detail.summary) : `${detail.branch} · not captured`,
    `Base ${detail.base_ref ?? "unknown"} at ${detail.base_sha ?? "unknown"}; start HEAD ${detail.start_head}; end HEAD ${detail.end_head ?? "unknown"}.`,
  ];
  if (detail.start_dirty || detail.start_untracked)
    lines.push("The checkout already had changes before this run; this record brackets an interval, not exclusive authorship.");
  if (detail.overlap.length)
    lines.push(`Other runs were active on this checkout during this run: ${detail.overlap.join(", ")}.`);
  for (const f of detail.files)
    lines.push(f.binary ? `${f.path} (binary)` : `${f.path} +${f.additions} −${f.deletions}`);
  for (const path of detail.untracked) lines.push(`${path} (untracked)`);
  if (detail.patch_truncated) lines.push("The stored patch was shortened.");
  if (detail.error) lines.push(`Capture error: ${detail.error}`);
  return lines.join("\n");
}

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
export function checkoutById(owner: string, checkoutId: string): CheckoutDetail | null {
  const row = db
    .prepare("SELECT * FROM run_checkouts WHERE id=? AND owner_id=?")
    .get(checkoutId, owner) as CheckoutRow | undefined;
  return row ? toDetail(row) : null;
}

/**
 * Record the checkout as the run begins. A run that resumes (after an
 * approval or an interruption) keeps its first start record. Never throws:
 * a capture failure is recorded on the run, not raised into its launch.
 */
export function startCheckout(
  run: Run,
  directory: string,
  source: string,
  generation: string | null,
) {
  if (!run.agent_id || !run.conversation_id) return;
  if (select(run.id)) return;
  const time = now();
  try {
    const branch = maybe(directory, ["symbolic-ref", "--short", "--quiet", "HEAD"]) ?? "HEAD";
    const head = must(directory, ["rev-parse", "--verify", "HEAD"]);
    const baseRef = maybe(source, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
    const sourceHead = maybe(source, ["rev-parse", "--verify", "HEAD"]);
    const baseSha = sourceHead ? maybe(directory, ["merge-base", "HEAD", sourceHead]) : null;
    const { tracked, untracked } = status(directory);
    const row: Partial<CheckoutRow> = {
      id: id(),
      owner_id: run.owner_id,
      run_id: run.id,
      agent_id: run.agent_id,
      conversation_id: run.conversation_id,
      generation,
      directory,
      source,
      branch,
      base_ref: baseRef,
      base_sha: baseSha,
      start_head: head,
      start_dirty: tracked.length ? 1 : 0,
      start_untracked: untracked.length ? 1 : 0,
      started_at: time,
      state: "started",
    };
    const summary = summarize(row as CheckoutRow);
    db.prepare(
      `INSERT OR IGNORE INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,generation,directory,source,branch,base_ref,base_sha,start_head,start_dirty,start_untracked,started_at,state,summary)
       VALUES(@id,@owner_id,@run_id,@agent_id,@conversation_id,@generation,@directory,@source,@branch,@base_ref,@base_sha,@start_head,@start_dirty,@start_untracked,@started_at,@state,@summary)`,
    ).run({ ...row, summary: JSON.stringify(summary) });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Checkout capture failed";
    const row = {
      id: id(),
      owner_id: run.owner_id,
      run_id: run.id,
      agent_id: run.agent_id,
      conversation_id: run.conversation_id,
      generation,
      directory,
      source,
      branch: "HEAD",
      start_head: "",
      started_at: time,
      error: message,
    };
    db.prepare(
      `INSERT OR IGNORE INTO run_checkouts(id,owner_id,run_id,agent_id,conversation_id,generation,directory,source,branch,start_head,start_dirty,start_untracked,started_at,state,error,summary)
       VALUES(@id,@owner_id,@run_id,@agent_id,@conversation_id,@generation,@directory,@source,@branch,@start_head,0,0,@started_at,'failed',@error,@summary)`,
    ).run({
      ...row,
      summary: JSON.stringify(
        summarize({ ...row, state: "failed", base_ref: null, base_sha: null, start_dirty: 0, start_untracked: 0 } as CheckoutRow),
      ),
    });
  }
}

/**
 * Capture the end state when a run reaches a terminal state. A run that ends
 * more than once (interrupted, then resumed and completed) is recaptured, so
 * the record describes the checkout at its latest end. Synchronous Git on a
 * large repository can take a moment; callers schedule this off the
 * transition path. Never throws.
 */
export function completeCheckout(runId: string) {
  const row = select(runId);
  if (!row || (row.state === "failed" && !row.start_head)) return;
  const time = now();
  const fields: Partial<CheckoutRow> = { ended_at: time, error: null };
  try {
    const directory = row.directory;
    const head = must(directory, ["rev-parse", "--verify", "HEAD"]);
    const sourceHead = maybe(row.source, ["rev-parse", "--verify", "HEAD"]);
    const base = sourceHead
      ? (maybe(directory, ["merge-base", "HEAD", sourceHead]) ?? row.base_sha)
      : row.base_sha;
    fields.end_head = head;
    fields.base_sha = base;
    if (sourceHead) {
      const counts = maybe(directory, ["rev-list", "--left-right", "--count", `${sourceHead}...HEAD`]);
      const [behind, ahead] = (counts ?? "").split(/\s+/).map(Number);
      if (Number.isFinite(ahead) && Number.isFinite(behind)) {
        fields.ahead = ahead;
        fields.behind = behind;
      }
    }
    const { untracked } = status(directory);
    fields.untracked = JSON.stringify(untracked);
    fields.working = JSON.stringify(numstat(directory, ["HEAD", "--"]));
    if (base) {
      fields.committed = JSON.stringify(numstat(directory, [base, "HEAD", "--"]));
      fields.files = JSON.stringify(numstat(directory, [base, "--"]).files);
      const p = patch(directory, base);
      fields.patch = p.patch;
      fields.patch_bytes = p.bytes;
      fields.patch_truncated = p.truncated ? 1 : 0;
    } else {
      // No shared base with the source: show the working tree against HEAD
      // and say so through the missing base.
      fields.committed = null;
      fields.files = fields.working ? JSON.stringify((JSON.parse(fields.working) as CheckoutStat).files) : "[]";
      const p = patch(directory, "HEAD");
      fields.patch = p.patch;
      fields.patch_bytes = p.bytes;
      fields.patch_truncated = p.truncated ? 1 : 0;
    }
    const seen = remote(directory, row.branch);
    fields.remote = seen ? JSON.stringify(seen) : null;
    fields.overlap = JSON.stringify(
      (
        db
          .prepare(
            `SELECT r.id FROM runs r JOIN companion_sessions s ON s.conversation_id=r.conversation_id
             WHERE r.owner_id=? AND s.project=? AND r.id<>? AND r.state<>'queued'
               AND r.created_at<=? AND r.updated_at>=? ORDER BY r.created_at`,
          )
          .all(row.owner_id, directory, row.run_id, time, row.started_at) as { id: string }[]
      ).map((r) => r.id),
    );
    fields.state = "captured";
  } catch (error) {
    fields.state = "failed";
    fields.error = error instanceof Error ? error.message.slice(0, 500) : "Checkout capture failed";
  }
  const next = { ...row, ...fields } as CheckoutRow;
  next.summary = JSON.stringify(summarize(next));
  db.prepare(
    `UPDATE run_checkouts SET state=@state,end_head=@end_head,base_sha=@base_sha,ahead=@ahead,behind=@behind,files=@files,committed=@committed,working=@working,untracked=@untracked,patch=@patch,patch_bytes=@patch_bytes,patch_truncated=@patch_truncated,remote=@remote,overlap=@overlap,summary=@summary,ended_at=@ended_at,error=@error WHERE run_id=@run_id`,
  ).run({
    state: next.state,
    end_head: next.end_head ?? null,
    base_sha: next.base_sha ?? null,
    ahead: next.ahead ?? null,
    behind: next.behind ?? null,
    files: next.files ?? null,
    committed: next.committed ?? null,
    working: next.working ?? null,
    untracked: next.untracked ?? null,
    patch: next.patch ?? null,
    patch_bytes: next.patch_bytes ?? null,
    patch_truncated: next.patch_truncated ?? null,
    remote: next.remote ?? null,
    overlap: next.overlap ?? null,
    summary: next.summary,
    ended_at: next.ended_at ?? null,
    error: next.error ?? null,
    run_id: row.run_id,
  });
}

export const TERMINAL_STATES = ["completed", "failed", "interrupted", "cancelled"];
