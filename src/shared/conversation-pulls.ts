import { GitHubPullNumber, GitCommitId } from "./contract-ids.js";
import { z } from "zod";

export const ConversationPull = z.object({
  owner: z.string(),
  repo: z.string(),
  number: GitHubPullNumber.int().positive(),
  title: z.string().optional(),
  state: z.enum(["draft", "open", "closed", "merged"]).optional(),
  headSha: GitCommitId.optional(),
  changedFiles: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  review: z
    .enum(["approved", "changes_requested", "review_required"])
    .optional(),
  requested: z.array(z.string()).optional(),
  reviews: z
    .array(
      z.object({
        author: z.string(),
        state: z.enum([
          "approved",
          "changes_requested",
          "commented",
          "dismissed",
        ]),
        headSha: GitCommitId.optional(),
      }),
    )
    .optional(),
  reviewsOmitted: z.boolean().optional(),
  fetchedAt: z.number().optional(),
  error: z.string().optional(),
});
export type ConversationPull = z.input<typeof ConversationPull>;
export const ConversationPulls = z.object({
  connected: z.boolean(),
  pulls: z.array(ConversationPull),
  hasMore: z.boolean(),
});
export type ConversationPulls = z.input<typeof ConversationPulls>;
