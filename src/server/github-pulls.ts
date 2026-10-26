import { workspaceApi } from "../shared/workspace-api.js";
import {
  PullReviewInput,
  PullCommentInput,
  PullMergeInput,
} from "../shared/github-contract-schemas.js";
import { registrar } from "./registrar.js";
import { type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { now } from "./db.js";
import { Problem } from "./domain.js";
import {
  GithubError,
  githubGraphql,
  githubRaw,
  githubRest,
  githubTokens,
} from "./github-api.js";
import {
  parsePullRequestUrl,
  pullRequestUrl,
  type PullRequestRef,
  type PullRequestState,
} from "../shared/github.js";
import {
  isRepoPath,
  repoMediaType,
  type ChecksState,
  type MergeMethod,
  type PullCheck,
  type PullComment,
  type PullCommitFiles,
  type PullDetail,
  type PullFile,
  type PullFilter,
  type PullInbox,
  type PullListItem,
  type ReviewDecision,
} from "../shared/pull-requests.js";
import type { ConversationPull } from "../shared/conversation-pulls.js";

// The Pull requests screen reads GitHub directly with your official GitHub
// connection, so you can find, read and act on pull requests without asking
// an agent. Actions here are yours: each one is a single request you
// submitted, pinned to the head commit you were shown. Nothing read here is
// passed to an agent.

const SHA = /^[0-9a-f]{40}$/i;
const BODY_CHARS = 60_000;
const COMMENT_CHARS = 20_000;
const COMMIT_MESSAGE_CHARS = 4_000;
const PATCH_CHARS = 100_000;
const MAX_FILES = 300;
const MAX_THREADS = 500;

const reading = (owner: string) => githubTokens(owner)[0];
// Writes act as one GitHub identity: with several GitHub connections Loop
// would have to guess which account you mean, so it asks you to keep one.
function writing(owner: string) {
  const tokens = githubTokens(owner);
  if (!tokens.length) throw new Problem(409, "Connect GitHub in Tools first.");
  if (tokens.length > 1)
    throw new Problem(
      409,
      "More than one GitHub account is connected. Keep one GitHub connection in Tools to act on pull requests from Loop.",
    );
  return tokens[0];
}

/** GitHub failures as Loop problems; never a 401, which signs you out of Loop. */
function problem(error: unknown, write = false): never {
  if (error instanceof Problem) throw error;
  if (error instanceof GithubError)
    throw new Problem(
      error.retryAt
        ? 429
        : error.status === 401
          ? 409
          : [403, 404, 405, 409, 413, 422].includes(error.status)
            ? error.status === 405
              ? 409
              : error.status
            : 502,
      error.message,
    );
  if (
    (error as Error)?.name === "TimeoutError" ||
    (error as Error)?.name === "AbortError"
  )
    throw new Problem(
      504,
      write
        ? "GitHub didn't answer in time. Refresh to see whether it went through before trying again."
        : "GitHub didn't answer in time. Try again.",
    );
  throw new Problem(502, "Could not reach GitHub. Try again.");
}

// ---------------------------------------------------------------------------
// Reading

const ITEM = `
  number title url state isDraft createdAt updatedAt
  author { login }
  headRefName baseRefName changedFiles additions deletions
  reviewDecision
  totalCommentsCount
  lastCommit: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`;

const text = (value: unknown, max = 300) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
const commitMessage = (value: unknown) => {
  const message = text(value, COMMIT_MESSAGE_CHARS + 1);
  if (!message) return "Untitled commit";
  return message.length > COMMIT_MESSAGE_CHARS
    ? message.slice(0, COMMIT_MESSAGE_CHARS) +
        "\n\n[… shortened; read the rest on GitHub]"
    : message;
};
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
const login = (value: any) => text(value?.login, 39);
const nodes = (value: any) => (Array.isArray(value?.nodes) ? value.nodes : []);

function checksState(value: unknown): ChecksState | undefined {
  switch (value) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
  }
}
function reviewDecision(value: unknown): ReviewDecision | undefined {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
  }
}

/** A GraphQL pull request as a list item, or undefined if it isn't one. */
function listItem(
  node: any,
  expected?: PullRequestRef,
): PullListItem | undefined {
  const url = text(node?.url, 500);
  const ref = url ? parsePullRequestUrl(url) : undefined;
  const title = text(node?.title);
  if (!ref || !title || node.number !== ref.number) return;
  if (
    expected &&
    (ref.owner.toLowerCase() !== expected.owner.toLowerCase() ||
      ref.repo.toLowerCase() !== expected.repo.toLowerCase() ||
      ref.number !== expected.number)
  )
    return;
  const state: PullRequestState =
    node.state === "MERGED"
      ? "merged"
      : node.state === "CLOSED"
        ? "closed"
        : node.isDraft
          ? "draft"
          : "open";
  const commit = node.lastCommit?.nodes?.[0]?.commit;
  return {
    ...ref,
    title,
    url: pullRequestUrl(ref),
    state,
    author: login(node.author),
    createdAt: text(node.createdAt, 40),
    updatedAt: text(node.updatedAt, 40),
    headRef: text(node.headRefName, 255),
    baseRef: text(node.baseRefName, 255),
    changedFiles: count(node.changedFiles),
    additions: count(node.additions),
    deletions: count(node.deletions),
    comments: count(node.totalCommentsCount),
    checks: checksState(commit?.statusCheckRollup?.state),
    review: reviewDecision(node.reviewDecision),
  };
}

const FILTER_QUALIFIER: Record<PullFilter, string> = {
  review: "review-requested:@me",
  authored: "author:@me",
  involved: "involves:@me",
};

const summaries = new Map<string, ConversationPull>();
const summaryReads = new Map<string, Promise<ConversationPull>>();
const summaryFailures = new Map<string, { error: unknown; retryAt: number }>();

/** A small, current PR/review read for conversations; no checkout or CI data. */
export async function pullSummary(
  owner: string,
  ref: PullRequestRef,
  refresh = false,
): Promise<ConversationPull> {
  const token = reading(owner);
  if (!token)
    throw new Problem(409, "Connect GitHub to refresh pull requests.");
  // Never reuse another owner's or a replaced connection's private data.
  const connection = JSON.stringify([
    owner,
    createHash("sha256").update(token).digest("hex"),
  ]);
  const key = JSON.stringify([
    connection,
    ref.owner.toLowerCase(),
    ref.repo.toLowerCase(),
    ref.number,
  ]);
  // Rate limits apply to every summary using this connection, including
  // manual refresh. Other failures back off automatic reads for one minute.
  for (const failureKey of refresh ? [connection] : [connection, key]) {
    const failure = summaryFailures.get(failureKey);
    if (failure && failure.retryAt > now()) problem(failure.error);
    summaryFailures.delete(failureKey);
  }
  const cached = summaries.get(key);
  if (!refresh && cached?.fetchedAt && now() - cached.fetchedAt < 60_000)
    return cached;
  const pending = summaryReads.get(key);
  if (pending) return pending;
  const read = (async () => {
    const data = await githubGraphql<any>(
      token,
      `query ConversationPull($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          number title url state isDraft headRefOid changedFiles additions deletions reviewDecision
          reviewRequests(first: 20) { pageInfo { hasNextPage } nodes { requestedReviewer {
            __typename ... on User { login } ... on Team { slug } ... on Bot { login }
          } } }
          latestReviews(first: 20) { pageInfo { hasNextPage } nodes { author { login } state commit { oid } } }
        } }
      }`,
      { owner: ref.owner, name: ref.repo, number: ref.number },
    );
    const node = data?.repository?.pullRequest;
    const item = listItem(node, ref);
    const headSha = text(node?.headRefOid, 40);
    if (!item || !headSha || !SHA.test(headSha))
      throw new Problem(
        404,
        "GitHub could not find this pull request with your connection.",
      );
    const result: ConversationPull = {
      ...ref,
      title: item.title,
      state: item.state,
      headSha,
      changedFiles: item.changedFiles,
      additions: item.additions,
      deletions: item.deletions,
      review: item.review,
      requested: nodes(node.reviewRequests).flatMap((r: any) => {
        const reviewer = r?.requestedReviewer;
        const name =
          reviewer?.__typename === "Team"
            ? text(reviewer.slug, 100)
            : login(reviewer);
        return name
          ? [reviewer.__typename === "Team" ? `team ${name}` : `@${name}`]
          : [];
      }),
      reviews: nodes(node.latestReviews).flatMap((r: any) => {
        const author = login(r?.author);
        const state = text(r?.state)?.toLowerCase();
        if (
          !author ||
          !["approved", "changes_requested", "commented", "dismissed"].includes(
            state ?? "",
          )
        )
          return [];
        return [
          {
            author,
            state: state as NonNullable<
              ConversationPull["reviews"]
            >[number]["state"],
            headSha: text(r?.commit?.oid, 40),
          },
        ];
      }),
      reviewsOmitted: !!(
        node.latestReviews?.pageInfo?.hasNextPage ||
        node.reviewRequests?.pageInfo?.hasNextPage
      ),
      fetchedAt: now(),
    };
    summaries.delete(key);
    summaries.set(key, result);
    summaryFailures.delete(key);
    if (summaries.size > 500) summaries.delete(summaries.keys().next().value!);
    return result;
  })()
    .catch((error) => {
      summaries.delete(key);
      const limited = error instanceof GithubError && error.retryAt;
      const failureKey = limited ? connection : key;
      summaryFailures.delete(failureKey);
      summaryFailures.set(failureKey, {
        error,
        retryAt: limited || now() + 60_000,
      });
      if (summaryFailures.size > 500)
        summaryFailures.delete(summaryFailures.keys().next().value!);
      problem(error);
    })
    .finally(() => {
      summaryReads.delete(key);
    });
  summaryReads.set(key, read);
  return read;
}

/** Open pull requests for you, one filter at a time, with every filter's count. */
export async function inbox(
  owner: string,
  options: { filter?: PullFilter; repo?: string; text?: string } = {},
): Promise<PullInbox> {
  const token = reading(owner);
  if (!token) return { connected: false };
  const filter = options.filter || "authored";
  // Your own search terms narrow the list; quotes and line breaks are
  // dropped so they can't end the query early.
  const terms = (options.text || "")
    .replace(/["\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const query = (f: PullFilter) =>
    [
      "is:pr is:open archived:false",
      FILTER_QUALIFIER[f],
      options.repo ? "repo:" + options.repo : "",
      terms,
      "sort:updated-desc",
    ]
      .filter(Boolean)
      .join(" ");
  let data: any;
  try {
    data = await githubGraphql<any>(
      token,
      `query Inbox($q: String!, $review: String!, $authored: String!, $involved: String!) {
        viewer { login }
        results: search(query: $q, type: ISSUE, first: 50) { issueCount nodes { ... on PullRequest { ${ITEM} } } }
        review: search(query: $review, type: ISSUE, first: 1) { issueCount }
        authored: search(query: $authored, type: ISSUE, first: 1) { issueCount }
        involved: search(query: $involved, type: ISSUE, first: 1) { issueCount }
      }`,
      {
        q: query(filter),
        review: query("review"),
        authored: query("authored"),
        involved: query("involved"),
      },
    );
  } catch (error) {
    problem(error);
  }
  const pulls = (Array.isArray(data?.results?.nodes) ? data.results.nodes : [])
    .map((node: any) => listItem(node))
    .filter((p: PullListItem | undefined): p is PullListItem => !!p);
  return {
    connected: true,
    login: login(data?.viewer) || "",
    filter,
    ...(options.repo ? { repo: options.repo } : {}),
    counts: {
      review: count(data?.review?.issueCount) ?? 0,
      authored: count(data?.authored?.issueCount) ?? 0,
      involved: count(data?.involved?.issueCount) ?? 0,
    },
    total: count(data?.results?.issueCount) ?? pulls.length,
    pulls,
    fetchedAt: now(),
  };
}

// GitHub hides HTML comments (pull request templates are full of them); other
// HTML is shown as text, never rendered.
const markdown = (value: unknown) =>
  typeof value === "string" ? value.replace(/<!--[\s\S]*?-->/g, "").trim() : "";

const ROLE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
function comment(node: any, chars = COMMENT_CHARS): PullComment | undefined {
  if (!node || typeof node !== "object") return;
  const body = markdown(node.body);
  return {
    author: login(node.author),
    body:
      body.length > chars ? body.slice(0, chars) + "\n\n[… shortened]" : body,
    createdAt: text(node.submittedAt || node.createdAt, 40),
    url: githubLink(node.url),
    member: ROLE.has(node.authorAssociation),
  };
}
// Links shown from GitHub data must point at github.com.
function githubLink(value: unknown) {
  const url = text(value, 1000);
  if (!url) return;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      ? parsed.href
      : undefined;
  } catch {}
}
function checkLink(value: unknown) {
  const url = text(value, 1000);
  if (!url) return;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {}
}

function checkRun(node: any): PullCheck | undefined {
  if (node?.__typename === "CheckRun") {
    const name = text(node.name, 200);
    if (!name) return;
    const conclusion = node.conclusion;
    return {
      name,
      state:
        node.status !== "COMPLETED"
          ? "pending"
          : conclusion === "SUCCESS"
            ? "success"
            : conclusion === "NEUTRAL"
              ? "neutral"
              : conclusion === "SKIPPED"
                ? "skipped"
                : "failure",
      url: checkLink(node.detailsUrl),
    };
  }
  if (node?.__typename === "StatusContext") {
    const name = text(node.context, 200);
    if (!name) return;
    return {
      name,
      state: checksState(node.state) || "pending",
      url: checkLink(node.targetUrl),
      description: text(node.description, 200),
    };
  }
}

// Review threads come a page at a time; each says how many comments it has so
// a long thread can say what it leaves out.
const THREADS = `totalCount pageInfo { hasNextPage endCursor }
  nodes { id isResolved isOutdated path line originalLine
    comments(first: 30) { totalCount nodes { author { login } authorAssociation body createdAt url } } }`;

/** One pull request with what you need to review it, read now. */
export async function detail(
  owner: string,
  ref: PullRequestRef,
): Promise<PullDetail> {
  const token = reading(owner);
  if (!token) throw new Problem(409, "Connect GitHub in Tools first.");
  let data: any;
  try {
    data = await githubGraphql<any>(
      token,
      `query Pull($owner: String!, $name: String!, $number: Int!) {
        viewer { login }
        repository(owner: $owner, name: $name) {
          viewerPermission
          mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
          pullRequest(number: $number) {
            ${ITEM}
            body headRefOid mergeable mergeStateStatus viewerDidAuthor
            commitCount: commits(first: 1) { totalCount }
            commitHistory: commits(last: 100) { nodes { commit { oid message committedDate author { name user { login } } } } }
            reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
            reviews(last: 50, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { totalCount nodes { author { login } authorAssociation state body submittedAt url } }
            reviewThreads(first: 100) { ${THREADS} }
            comments(last: 50) { totalCount nodes { author { login } authorAssociation body createdAt url } }
            checkCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl description }
            } } } } } }
          }
        }
      }`,
      { owner: ref.owner, name: ref.repo, number: ref.number },
    );
  } catch (error) {
    problem(error);
  }
  const repository = data?.repository;
  const node = repository?.pullRequest;
  const item = node ? listItem(node, ref) : undefined;
  const headSha = text(node?.headRefOid, 40);
  if (!item || !headSha || !SHA.test(headSha))
    throw new Problem(
      404,
      "GitHub could not find this pull request with your connection.",
    );
  // Later pages of review threads, so an unresolved thread past the first
  // page still shows; past MAX_THREADS the page says how many it left out.
  const threadNodes = [...nodes(node.reviewThreads)];
  let pageInfo = node.reviewThreads?.pageInfo;
  try {
    while (
      pageInfo?.hasNextPage === true &&
      typeof pageInfo.endCursor === "string" &&
      threadNodes.length < MAX_THREADS
    ) {
      const more = await githubGraphql<any>(
        token,
        `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { ${THREADS} } }
          }
        }`,
        {
          owner: ref.owner,
          name: ref.repo,
          number: ref.number,
          after: pageInfo.endCursor,
        },
      );
      const connection = more?.repository?.pullRequest?.reviewThreads;
      if (!nodes(connection).length) break;
      threadNodes.push(...nodes(connection));
      pageInfo = connection.pageInfo;
    }
  } catch (error) {
    problem(error);
  }
  const viewerLogin = login(data.viewer) || "";
  const methods: MergeMethod[] = [];
  if (repository.squashMergeAllowed) methods.push("squash");
  if (repository.mergeCommitAllowed) methods.push("merge");
  if (repository.rebaseMergeAllowed) methods.push("rebase");
  const contexts = nodes(
    node.checkCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts,
  );
  // GitHub files a blank COMMENTED review each time someone leaves inline
  // comments from the Files tab; those comments already show under review
  // threads, so only reviews with something to say are listed and counted.
  const reviewNodes = nodes(node.reviews);
  const reviews = reviewNodes
    .map((r: any) => {
      const c = comment(r);
      const state = text(r?.state, 40);
      return c &&
        state &&
        state !== "PENDING" &&
        (c.body.trim() || state !== "COMMENTED")
        ? { ...c, state: state.toLowerCase() }
        : undefined;
    })
    .filter(
      (
        r: (PullComment & { state: string }) | undefined,
      ): r is PullComment & { state: string } => !!r,
    );
  // GitHub's total includes blank inline-comment reviews. Older reviews may
  // also be blank, so their displayable count cannot be inferred from it.
  const reviewsOmitted =
    (count(node.reviews?.totalCount) ?? 0) > reviewNodes.length;
  const body = markdown(node.body);
  return {
    ...item,
    body:
      body.length > BODY_CHARS
        ? body.slice(0, BODY_CHARS) +
          "\n\n[… shortened; read the rest on GitHub]"
        : body,
    headSha,
    mergeState: text(node.mergeStateStatus, 40)?.toLowerCase(),
    conflicts: node.mergeable === "CONFLICTING",
    commits: count(node.commitCount?.totalCount),
    commitHistory: nodes(node.commitHistory).flatMap((entry: any) => {
      const commit = entry?.commit;
      const sha = text(commit?.oid, 40);
      if (!sha || !SHA.test(sha)) return [];
      return [
        {
          sha,
          message: commitMessage(commit.message),
          author: login(commit.author?.user) || text(commit.author?.name, 100),
          committedAt: text(commit.committedDate, 40),
          url: `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commit/${sha}`,
        },
      ];
    }),
    requested: nodes(node.reviewRequests)
      .map((r: any) =>
        r?.requestedReviewer?.__typename === "Team"
          ? text(r.requestedReviewer.slug, 100) &&
            "team " + r.requestedReviewer.slug
          : login(r?.requestedReviewer),
      )
      .filter((r: unknown): r is string => typeof r === "string")
      .slice(0, 20),
    reviews,
    reviewsTotal: reviews.length,
    reviewsOmitted,
    checkRuns: contexts
      .map(checkRun)
      .filter((c: PullCheck | undefined): c is PullCheck => !!c),
    threads: threadNodes
      .slice(0, MAX_THREADS)
      .map((t: any) => {
        const comments = nodes(t?.comments)
          .map((c: any) => comment(c))
          .filter(Boolean);
        return {
          id: text(t?.id, 100) || "",
          path: text(t?.path, 500) || "",
          line: count(t?.line) ?? count(t?.originalLine),
          resolved: t?.isResolved === true,
          outdated: t?.isOutdated === true,
          comments,
          commentsTotal: count(t?.comments?.totalCount) ?? comments.length,
        };
      })
      .filter((t: any) => t.id && t.comments.length),
    threadsTotal: count(node.reviewThreads?.totalCount) ?? threadNodes.length,
    conversation: nodes(node.comments)
      .map((c: any) => comment(c))
      .filter(Boolean),
    conversationTotal: count(node.comments?.totalCount) ?? 0,
    viewer: {
      login: viewerLogin,
      author: node.viewerDidAuthor === true,
      canMerge: ["ADMIN", "MAINTAIN", "WRITE"].includes(
        repository.viewerPermission,
      ),
    },
    mergeMethods: methods,
    fetchedAt: now(),
  };
}

function changedFile(f: any): PullFile | undefined {
  const path = text(f?.filename, 1000);
  if (!path) return;
  const patch = typeof f.patch === "string" ? f.patch : undefined;
  return {
    path,
    previousPath: text(f.previous_filename, 1000),
    status: text(f.status, 20) || "modified",
    additions: count(f.additions) ?? 0,
    deletions: count(f.deletions) ?? 0,
    patch:
      patch && patch.length > PATCH_CHARS ? patch.slice(0, PATCH_CHARS) : patch,
    truncated: !!patch && patch.length > PATCH_CHARS,
  };
}

/**
 * The changed files with their diffs, up to MAX_FILES, for the
 * head commit you were shown: GitHub lists the files of whatever the head is
 * now, so a head that moved before or while reading them is refused.
 */
export async function files(
  owner: string,
  ref: PullRequestRef,
  headSha: string,
) {
  const token = reading(owner);
  if (!token) throw new Problem(409, "Connect GitHub in Tools first.");
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/files?per_page=100&page=`;
  const list: PullFile[] = [];
  const moved = () =>
    new Problem(
      409,
      "New commits were pushed after you opened this pull request. Refresh to see their changes.",
    );
  try {
    if ((await headOf(token, ref)) !== headSha.toLowerCase()) throw moved();
    for (let page = 1; list.length < MAX_FILES; page++) {
      const { data, link } = await githubRest<any[]>(token, base + page);
      for (const f of Array.isArray(data) ? data : []) {
        const file = changedFile(f);
        if (file) list.push(file);
      }
      if (!/rel="next"/.test(link) || !data?.length) break;
    }
    if ((await headOf(token, ref)) !== headSha.toLowerCase()) throw moved();
  } catch (error) {
    problem(error);
  }
  return { files: list.slice(0, MAX_FILES), headSha, fetchedAt: now() };
}

/** Changes to an immutable commit, independent of the pull request's current head. */
export async function commitFiles(
  owner: string,
  ref: PullRequestRef,
  sha: string,
): Promise<PullCommitFiles> {
  const token = reading(owner);
  if (!token) throw new Problem(409, "Connect GitHub in Tools first.");
  const list: PullFile[] = [];
  let hasMore = false;
  try {
    // Check access to the pull request with this owner's connection.
    await headOf(token, ref);
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${sha.toLowerCase()}?per_page=100&page=`;
    for (let page = 1; page <= MAX_FILES / 100; page++) {
      const { data, link } = await githubRest<any>(token, base + page);
      if (
        data?.sha?.toLowerCase() !== sha.toLowerCase() ||
        !Array.isArray(data.files)
      )
        throw new Problem(
          502,
          "GitHub did not return the requested commit's changes. Try again.",
        );
      for (const f of data.files) {
        const file = changedFile(f);
        if (file) list.push(file);
      }
      hasMore = /rel="next"/.test(link) || list.length > MAX_FILES;
      if (!hasMore || !data.files.length || list.length >= MAX_FILES) break;
    }
  } catch (error) {
    problem(error);
  }
  return {
    files: list.slice(0, MAX_FILES),
    sha: sha.toLowerCase(),
    hasMore,
    fetchedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Viewing one file as it is at a commit: the pull request's head, or any file
// it links to. A commit's files never change, so a copy is kept for a day and
// served with range requests, which phones need to play video.

const VIEW_BYTES = 50 * 1024 * 1024;
const VIEW_CACHE_BYTES = 500 * 1024 * 1024;
const VIEW_CACHE_MS = 24 * 3600_000;
const viewCache = () => join(config.data, "cache", "github-files");

/** Drops copies older than a day, then the oldest until the cache fits. */
function pruneViews(directory: string) {
  const entries = readdirSync(directory).flatMap((name) => {
    try {
      const stat = statSync(join(directory, name));
      return [{ name, size: stat.size, at: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries.sort((a, b) => a.at - b.at)) {
    if (now() - entry.at < VIEW_CACHE_MS && total <= VIEW_CACHE_BYTES) break;
    try {
      unlinkSync(join(directory, entry.name));
      total -= entry.size;
    } catch {}
  }
}

/** Whether a file's first bytes look like text (no NUL bytes). */
function looksLikeText(file: string) {
  const descriptor = openSync(file, "r");
  try {
    const head = Buffer.alloc(8000);
    const read = readSync(descriptor, head, 0, head.length, 0);
    return !head.subarray(0, read).includes(0);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The file at `path` in the commit `head`, read with your GitHub connection
 * and kept for you alone. Returns where the copy is.
 */
export async function fileAt(
  owner: string,
  ref: PullRequestRef,
  head: string,
  path: string,
) {
  const token = reading(owner);
  if (!token) throw new Problem(409, "Connect GitHub in Tools first.");
  const directory = viewCache();
  const file = join(
    directory,
    createHash("sha256")
      .update(
        JSON.stringify([owner, ref.owner, ref.repo, head.toLowerCase(), path]),
      )
      .digest("hex"),
  );
  try {
    statSync(file);
    return file;
  } catch {}
  let bytes: Buffer;
  try {
    bytes = await githubRaw(
      token,
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${head.toLowerCase()}`,
      VIEW_BYTES,
    );
  } catch (error) {
    problem(error);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, file);
  pruneViews(directory);
  return file;
}

/** Sends a viewed file as an image, a video, plain text or a download only. */
function sendViewed(res: Response, file: string, path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const media = repoMediaType(path);
  const text = !media && looksLikeText(file);
  res.setHeader(
    "Content-Type",
    media || (text ? "text/plain; charset=utf-8" : "application/octet-stream"),
  );
  res.setHeader(
    "Content-Disposition",
    `${media || text ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  // An SVG opened on its own must not run scripts or load anything else.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  res.setHeader("Cache-Control", "private, max-age=86400, immutable");
  res.sendFile(file, {
    cacheControl: false,
    lastModified: false,
    dotfiles: "allow",
  });
}

// ---------------------------------------------------------------------------
// Acting. Each action is a single request you submitted; nothing is retried.

const pullPath = (ref: PullRequestRef) =>
  `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`;

async function readPull(token: string, ref: PullRequestRef) {
  return (await githubRest<any>(token, pullPath(ref))).data;
}
const headOf = async (token: string, ref: PullRequestRef) =>
  String((await readPull(token, ref))?.head?.sha || "").toLowerCase();

/** Refuses to act on a pull request whose head moved since you read it. */
async function current(token: string, ref: PullRequestRef, headSha: string) {
  const data = await readPull(token, ref);
  if (data?.merged || data?.merged_at)
    throw new Problem(409, "This pull request was already merged.");
  if (data?.state === "closed")
    throw new Problem(409, "This pull request is closed.");
  if (String(data?.head?.sha || "").toLowerCase() !== headSha.toLowerCase())
    throw new Problem(
      409,
      "New commits were pushed after you opened this pull request. Refresh and look at them first.",
    );
}

const REVIEW_EVENT = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
} as const;

export async function review(
  owner: string,
  ref: PullRequestRef,
  body: unknown,
) {
  const input = PullReviewInput.parse(body);
  if (input.event !== "approve" && !input.body.trim())
    throw new Problem(
      400,
      input.event === "comment"
        ? "Write a comment first."
        : "Say what needs to change.",
    );
  const token = writing(owner);
  try {
    await current(token, ref, input.headSha);
    const { data } = await githubRest<any>(token, pullPath(ref) + "/reviews", {
      method: "POST",
      body: {
        event: REVIEW_EVENT[input.event],
        commit_id: input.headSha,
        ...(input.body.trim() ? { body: input.body.trim() } : {}),
      },
    });
    return { ok: true, url: githubLink(data?.html_url) };
  } catch (error) {
    problem(error, true);
  }
}

export async function addComment(
  owner: string,
  ref: PullRequestRef,
  body: unknown,
) {
  const input = PullCommentInput.parse(body);
  const token = writing(owner);
  try {
    if ((await headOf(token, ref)) !== input.headSha.toLowerCase())
      throw new Problem(
        409,
        "New commits were pushed after you opened this pull request. Refresh and look at them first.",
      );
    const { data } = await githubRest<any>(
      token,
      `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}/comments`,
      { method: "POST", body: { body: input.body } },
    );
    return { ok: true, url: githubLink(data?.html_url) };
  } catch (error) {
    problem(error, true);
  }
}

/**
 * Merges exactly the head commit you were shown: GitHub refuses the merge if
 * the branch moved, so new commits always need a fresh look.
 */
export async function merge(owner: string, ref: PullRequestRef, body: unknown) {
  const input = PullMergeInput.parse(body);
  const token = writing(owner);
  try {
    const { data } = await githubRest<any>(token, pullPath(ref) + "/merge", {
      method: "PUT",
      body: { merge_method: input.method, sha: input.headSha },
    });
    if (data?.merged !== true)
      throw new Problem(
        409,
        text(data?.message) || "GitHub did not merge this pull request.",
      );
    return { merged: true, sha: text(data?.sha, 40) };
  } catch (error) {
    if (error instanceof GithubError && error.status === 409)
      throw new Problem(
        409,
        "New commits were pushed after you opened this pull request. Refresh and look at them before merging.",
      );
    problem(error, true);
  }
}

// ---------------------------------------------------------------------------
// Routes

const routes = registrar("githubPulls");
export const githubPulls = routes.mount;
routes.on(workspaceApi.githubPullList, async (req, res) => {
  res.json(
    await inbox(res.locals.owner, {
      filter: req.query.filter,
      repo: req.query.repo,
      text: req.query.q,
    }),
  );
});
routes.on(workspaceApi.githubPullDetail, async (req, res) =>
  res.json(await detail(res.locals.owner, req.params)),
);
routes.on(workspaceApi.githubPullFiles, async (req, res) =>
  res.json(await files(res.locals.owner, req.params, req.query.head)),
);
routes.on(workspaceApi.githubPullCommitFiles, async (req, res) =>
  res.json(await commitFiles(res.locals.owner, req.params, req.params.sha)),
);
routes.on(workspaceApi.githubPullFile, async (req, res) => {
  sendViewed(
    res,
    await fileAt(res.locals.owner, req.params, req.query.head, req.query.path),
    req.query.path,
  );
});
routes.on(workspaceApi.githubPullReview, async (req, res) =>
  res.status(201).json(await review(res.locals.owner, req.params, req.body)),
);
routes.on(workspaceApi.githubPullComment, async (req, res) =>
  res
    .status(201)
    .json(await addComment(res.locals.owner, req.params, req.body)),
);
routes.on(workspaceApi.githubPullMerge, async (req, res) =>
  res.json(await merge(res.locals.owner, req.params, req.body)),
);
