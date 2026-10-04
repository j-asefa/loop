// The Pull requests screen: what the server reads from GitHub for you, without
// an agent. Titles, descriptions, comments and diffs are untrusted content
// from GitHub; they are shown to you and never passed to an agent from here.

import type { PullRequestRef, PullRequestState } from "./github";

export type PullFilter = "review" | "authored" | "involved";

export const PULL_FILTERS: { id: PullFilter; label: string }[] = [
  { id: "review", label: "Review requested" },
  { id: "authored", label: "Yours" },
  { id: "involved", label: "Involving you" },
];

/** The combined result of a pull request's checks on its head commit. */
export type ChecksState = "success" | "failure" | "pending";
export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export type PullListItem = PullRequestRef & {
  title: string;
  url: string;
  state: PullRequestState;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  headRef?: string;
  baseRef?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  comments?: number;
  checks?: ChecksState;
  review?: ReviewDecision;
};

export type PullInbox =
  | { connected: false }
  | {
      connected: true;
      login: string;
      filter: PullFilter;
      repo?: string;
      counts: Record<PullFilter, number>;
      total: number;
      pulls: PullListItem[];
      fetchedAt: number;
    };

export type PullComment = {
  author?: string;
  body: string;
  createdAt?: string;
  url?: string;
  /** Whether the author has a role in the repository (owner, member, collaborator). */
  member: boolean;
};

export type PullCheck = {
  name: string;
  state: ChecksState | "neutral" | "skipped";
  url?: string;
  description?: string;
};

export type MergeMethod = "merge" | "squash" | "rebase";

export type PullDetail = PullListItem & {
  body: string;
  headSha: string;
  /** GitHub's merge state: clean, blocked, behind, dirty, draft, unstable… */
  mergeState?: string;
  conflicts: boolean;
  commits?: number;
  requested: string[];
  reviews: (PullComment & { state: string })[];
  checkRuns: PullCheck[];
  threads: {
    id: string;
    path: string;
    line?: number;
    resolved: boolean;
    outdated: boolean;
    comments: PullComment[];
    /** All the thread's comments on GitHub; more than `comments` when shortened. */
    commentsTotal: number;
  }[];
  /** All review threads on GitHub; more than `threads` when some were left out. */
  threadsTotal: number;
  conversation: PullComment[];
  conversationTotal: number;
  viewer: {
    login: string;
    author: boolean;
    /** Repository write access: GitHub may still block a merge (rules, checks). */
    canMerge: boolean;
  };
  mergeMethods: MergeMethod[];
  fetchedAt: number;
};

export type PullFile = {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** The unified diff hunk text; missing when GitHub omits a large or binary diff. */
  patch?: string;
  truncated?: boolean;
};

export type PullFiles = {
  files: PullFile[];
  total?: number;
  /** The head commit these changes are for. */
  headSha: string;
  fetchedAt: number;
};

export const MAX_REVIEW_BODY = 20_000;

// ---------------------------------------------------------------------------
// Viewing a file at the pull request's head commit

/** How the file viewer shows a repository file, chosen by its name. */
export type RepoFileKind = "markdown" | "image" | "video" | "text";

// The only types served for display. Anything else is sent as plain text or
// as a download, never as a document the browser would run.
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const extension = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";

/** The image or video type for a file name, or undefined for other files. */
export const repoMediaType = (path: string): string | undefined =>
  MEDIA_TYPES[extension(path)];

export function repoFileKind(path: string): RepoFileKind {
  const type = repoMediaType(path);
  if (type?.startsWith("image/")) return "image";
  if (type?.startsWith("video/")) return "video";
  return ["md", "markdown", "mdown", "mkd"].includes(extension(path))
    ? "markdown"
    : "text";
}

/** A relative path to a file in a repository: no empty, `.` or `..` parts. */
export const isRepoPath = (path: string) =>
  path.length > 0 &&
  path.length <= 1000 &&
  !/[\\\u0000-\u001f\u007f]/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");

/**
 * Where a link or image in a repository file points, resolved against that
 * file's folder the way GitHub does (a leading `/` is the repository root).
 * Undefined for links that leave the repository: other sites, other schemes,
 * or `..` past the root.
 */
export function resolveRepoPath(
  from: string,
  href: string,
): { path: string; hash?: string } | undefined {
  const value = href.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//"))
    return undefined;
  const hashAt = value.indexOf("#");
  const hash = hashAt < 0 ? undefined : value.slice(hashAt + 1) || undefined;
  const target = (hashAt < 0 ? value : value.slice(0, hashAt)).replace(/\?.*$/, "");
  if (!target) return { path: from, hash };
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join("/");
  return isRepoPath(path) ? { path, hash } : undefined;
}
