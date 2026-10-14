/** The one-line view of a run's checkout record; everything else is a tap away. */
export type CheckoutSummary = {
  id: string;
  state: "started" | "captured" | "failed";
  branch: string;
  base_ref: string | null;
  ahead: number | null;
  behind: number | null;
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
  /** What the local remote-tracking ref said at capture; Loop never fetches. */
  remote: "none" | "contains" | "missing";
  started_dirty: boolean;
  overlap: number;
  /** Captured after a restart, later than the run ended. */
  late: boolean;
  error: string | null;
};

export type CheckoutFile = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};
export type CheckoutStat = {
  files: CheckoutFile[];
  additions: number;
  deletions: number;
};
export type CheckoutRemote = {
  ref: string;
  sha: string;
  contains_head: boolean;
  observed_at: number;
};
export type CheckoutDetail = {
  id: string;
  run_id: string;
  agent_id: string;
  conversation_id: string;
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
  files: CheckoutFile[];
  committed: CheckoutStat | null;
  working: CheckoutStat | null;
  untracked: string[];
  patch: string | null;
  patch_bytes: number | null;
  patch_truncated: boolean;
  remote: CheckoutRemote | null;
  overlap: string[];
  captured_late: boolean;
  summary: CheckoutSummary | null;
  ended_at: number | null;
  error: string | null;
};

/** The card line. The same text is the brief's citable headline. */
export function checkoutLine(summary: CheckoutSummary) {
  const parts = [summary.branch];
  if (summary.ahead != null) {
    parts.push(
      summary.ahead === 1 ? "1 commit ahead" : `${summary.ahead} commits ahead`,
    );
    if (summary.behind) parts.push(`${summary.behind} behind`);
  }
  if (summary.state === "captured") {
    parts.push(
      summary.files
        ? `${summary.files} ${summary.files === 1 ? "file" : "files"} +${summary.additions} −${summary.deletions}`
        : "no changes",
    );
    if (summary.untracked) parts.push(`${summary.untracked} untracked`);
    parts.push(
      summary.remote === "contains"
        ? "on remote"
        : summary.remote === "missing"
          ? "not on remote"
          : "no remote seen",
    );
  } else if (summary.state === "failed") parts.push("checkout not captured");
  else parts.push("in progress");
  return parts.join(" · ");
}

/**
 * Git quotes a path containing control characters, a double quote or a
 * backslash in C style ("notes\\tdraft.txt") even with core.quotePath off.
 * Returns the raw path, or the input unchanged when it is not quoted.
 */
export function unquoteGitPath(path: string) {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
  const bytes: number[] = [];
  // By code point, so an emoji is encoded whole rather than as two halves.
  const inner = Array.from(path.slice(1, -1));
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const n = inner[++i];
    const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    if (n in simple) bytes.push(simple[n]);
    else if (/[0-7]/.test(n ?? "")) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(inner[i + 1] ?? "")) oct += inner[++i];
      bytes.push(parseInt(oct, 8));
    } else if (n !== undefined) bytes.push(...new TextEncoder().encode(n));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
