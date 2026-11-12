import { PullFileStatus } from "./pull-file-status.js";
import { z } from "zod";
import { isRepoPath, MAX_REVIEW_BODY } from "./pull-requests.js";

const Text = z.string();
const MaybeText = Text.nullable();
const Time = z.number();
const Name = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
export const CommitSha = Text.regex(
  /^[0-9a-f]{40}$/i,
  "Refresh the pull request first",
);
export const PullParams = z.object({
  owner: Text.regex(Name, "Unknown repository owner").max(39),
  repo: Text.regex(Name, "Unknown repository").max(100),
  number: z.coerce.number<string | number>().int().positive().max(999_999_999),
});
export const PullQuery = z.object({
  filter: z.enum(["review", "authored", "involved"]).optional(),
  repo: Text.regex(
    /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/,
    "Use owner/repository",
  )
    .optional()
    .or(z.literal("")),
  q: Text.max(200).optional(),
});
export const PullFileQuery = z.object({
  head: CommitSha,
  path: Text.refine(isRepoPath, "Choose a file in the repository"),
});
export const PullReviewInput = z.object({
  event: z.enum(["approve", "request_changes", "comment"]),
  body: Text.max(MAX_REVIEW_BODY).default(""),
  headSha: CommitSha,
});
export const PullCommentInput = z.object({
  body: Text.trim().min(1, "Write a comment first.").max(MAX_REVIEW_BODY),
  headSha: CommitSha,
});
export const PullMergeInput = z.object({
  method: z.enum(["merge", "squash", "rebase"]),
  headSha: CommitSha,
});
export const PrWatchInput = z.object({
  artifactId: Text.min(1).max(150),
  owner: Text.min(1).max(39),
  repo: Text.min(1).max(100),
  number: z.number().int().positive().max(999_999_999),
});

const Checks = z.enum(["success", "failure", "pending"]);
const PublicPullItem = z.object({
  owner: Text,
  repo: Text,
  number: z.number(),
  title: Text,
  url: Text,
  state: z.enum(["draft", "open", "merged", "closed"]),
  author: Text.optional(),
  createdAt: Text.optional(),
  updatedAt: Text.optional(),
  headRef: Text.optional(),
  baseRef: Text.optional(),
  changedFiles: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  comments: z.number().optional(),
  checks: Checks.optional(),
  review: z
    .enum(["approved", "changes_requested", "review_required"])
    .optional(),
});
export const PublicPullInbox = z.discriminatedUnion("connected", [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    login: Text,
    filter: z.enum(["review", "authored", "involved"]),
    repo: Text.optional(),
    counts: z.object({
      review: z.number(),
      authored: z.number(),
      involved: z.number(),
    }),
    total: z.number(),
    pulls: z.array(PublicPullItem),
    fetchedAt: Time,
  }),
]);
const PublicComment = z.object({
  author: Text.optional(),
  body: Text,
  createdAt: Text.optional(),
  url: Text.optional(),
  member: z.boolean(),
});
export const PublicPullDetail = PublicPullItem.extend({
  body: Text,
  headSha: Text,
  mergeState: Text.optional(),
  conflicts: z.boolean(),
  commits: z.number().optional(),
  commitHistory: z.array(
    z.object({
      sha: Text,
      message: Text,
      author: Text.optional(),
      committedAt: Text.optional(),
      url: Text,
    }),
  ),
  requested: z.array(Text),
  reviews: z.array(
    PublicComment.extend({
      state: z.enum([
        "approved",
        "changes_requested",
        "commented",
        "dismissed",
      ]),
    }),
  ),
  reviewsTotal: z.number(),
  reviewsOmitted: z.boolean(),
  checkRuns: z.array(
    z.object({
      name: Text,
      state: z.enum(["success", "failure", "pending", "neutral", "skipped"]),
      url: Text.optional(),
      description: Text.optional(),
    }),
  ),
  threads: z.array(
    z.object({
      id: Text,
      path: Text,
      line: z.number().optional(),
      resolved: z.boolean(),
      outdated: z.boolean(),
      comments: z.array(PublicComment),
      commentsTotal: z.number(),
    }),
  ),
  threadsTotal: z.number(),
  conversation: z.array(PublicComment),
  conversationTotal: z.number(),
  viewer: z.object({ login: Text, author: z.boolean(), canMerge: z.boolean() }),
  mergeMethods: z.array(z.enum(["merge", "squash", "rebase"])),
  fetchedAt: Time,
});
const PublicPullFile = z.object({
  path: Text,
  previousPath: Text.optional(),
  status: PullFileStatus,
  additions: z.number(),
  deletions: z.number(),
  patch: Text.optional(),
  truncated: z.boolean().optional(),
});
export const PublicPullFiles = z.object({
  files: z.array(PublicPullFile),
  total: z.number().optional(),
  headSha: Text,
  fetchedAt: Time,
});
export const PublicCommitFiles = z.object({
  files: z.array(PublicPullFile),
  sha: Text,
  hasMore: z.boolean(),
  fetchedAt: Time,
});
export const PublicPrWatch = z.object({
  id: Text,
  conversation_id: Text,
  agent_id: Text,
  repo_owner: Text,
  repo_name: Text,
  number: z.number(),
  state: z.enum(["watching", "paused", "stopped"]),
  ended_reason: MaybeText,
  error: MaybeText,
  head_sha: MaybeText,
  ci_sha: MaybeText,
  ci_conclusion: MaybeText,
  created_at: Time,
  updated_at: Time,
  ci_pending: z.number(),
  read_at: Time.nullable(),
  seen_ci_sha: MaybeText,
  seen_ci_conclusion: MaybeText,
});
export const PublicCreatedPrWatch = PublicPrWatch.extend({
  owner_id: Text,
  login: MaybeText,
  next_poll_at: Time,
  since_at: Time.nullable(),
});
