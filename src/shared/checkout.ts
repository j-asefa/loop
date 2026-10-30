/** The one-line view of a run's checkout record; everything else is a tap away. */
export type CheckoutSummary = {
  id: string;
  state: "started" | "captured" | "failed";
  /** Absent on historical cumulative comparisons with the source checkout. */
  scope?: "run";
  branch: string;
  base_ref: string | null;
  ahead: number | null;
  behind: number | null;
  files: number;
  additions: number;
  deletions: number;
  untracked: number;
  /** What the local remote-tracking ref said at capture; Loop55 never fetches. */
  remote: "none" | "contains" | "missing" | "unknown";
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
  /** Its attributes select a filter; Loop55 compared the raw content. */
  filtered?: boolean;
};
export type CheckoutStat = {
  files: CheckoutFile[];
  additions: number;
  deletions: number;
};
export type CheckoutRemote = {
  ref: string;
  sha: string;
  /** null when Git could not answer, for example a missing object. */
  contains_head: boolean | null;
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

/** The card line. */
export function checkoutParts(summary: CheckoutSummary) {
  const parts: (
    string | { files: number; additions: number; deletions: number }
  )[] = [summary.branch];
  if (summary.ahead != null) {
    parts.push(
      `${summary.ahead} ${summary.ahead === 1 ? "commit" : "commits"} ${summary.scope === "run" ? "since start" : "ahead"}`,
    );
    if (summary.behind)
      parts.push(
        `${summary.behind} ${summary.scope === "run" ? "removed since start" : "behind"}`,
      );
  }
  if (summary.state === "captured") {
    parts.push(
      summary.files
        ? {
            files: summary.files,
            additions: summary.additions,
            deletions: summary.deletions,
          }
        : "no changes",
    );
    if (summary.untracked) parts.push(`${summary.untracked} untracked`);
    parts.push(
      summary.remote === "contains"
        ? "on remote"
        : summary.remote === "missing"
          ? "not on remote"
          : summary.remote === "unknown"
            ? "remote state unknown"
            : "no remote seen",
    );
  } else if (summary.state === "failed") parts.push("checkout not captured");
  else parts.push("in progress");
  return parts;
}

export function checkoutLine(summary: CheckoutSummary) {
  return checkoutParts(summary)
    .map((part) =>
      typeof part === "string"
        ? part
        : `${part.files} ${part.files === 1 ? "file" : "files"} +${part.additions} −${part.deletions}`,
    )
    .join(" · ");
}

/**
 * Git quotes a path containing control characters, a double quote or a
 * backslash in C style ("notes\\tdraft.txt") even with core.quotePath off.
 * Returns the raw path, or the input unchanged when it is not quoted.
 */
export function unquoteGitPath(path: string) {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"')))
    return path;
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
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      "\\": 92,
    };
    if (n in simple) bytes.push(simple[n]);
    else if (/[0-7]/.test(n ?? "")) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(inner[i + 1] ?? ""))
        oct += inner[++i];
      bytes.push(parseInt(oct, 8));
    } else if (n !== undefined) bytes.push(...new TextEncoder().encode(n));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Split a stored unified diff into one chunk per file, keyed by the file's
 * path as numstat reports it. "+++ b/..." names a new path and "--- a/..."
 * a deleted one; a pure rename names its destination with "rename to"; a
 * mode-only change has neither, and its "diff --git a/P b/P" line names the
 * same path twice. Header lines other than "diff --git" and "index" stay in
 * the chunk, so rename and mode metadata remain visible.
 */
export function patchByFile(patch: string) {
  const chunks = new Map<string, string>();
  const quoted = (q: string) => unquoteGitPath(q).slice(2);
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const plus = chunk.match(/^\+\+\+ (?:b\/(.*)|("b\/(?:[^"\\]|\\.)*"))$/m);
    const minus = chunk.match(/^--- (?:a\/(.*)|("a\/(?:[^"\\]|\\.)*"))$/m);
    const renamed = chunk.match(/^rename to (.*)$/m);
    let path =
      plus?.[1] ??
      (plus?.[2] ? quoted(plus[2]) : undefined) ??
      minus?.[1] ??
      (minus?.[2] ? quoted(minus[2]) : undefined) ??
      (renamed ? unquoteGitPath(renamed[1]) : undefined);
    if (path === undefined) {
      // "diff --git a/P b/P": the same path twice, plain or quoted.
      const header = chunk.match(/^diff --git (.*)$/m)?.[1] ?? "";
      const half = (header.length - 1) / 2;
      const left = header.slice(0, half),
        right = header.slice(half + 1);
      const same =
        Number.isInteger(half) && left === right.replace(/^("?)b\//, "$1a/");
      path =
        same && /^"?a\//.test(left)
          ? left.startsWith('"')
            ? quoted(left)
            : left.slice(2)
          : "";
    }
    chunks.set(path, chunk.replace(/^diff --git .*\n(?:index .*\n)?/, ""));
  }
  return chunks;
}
