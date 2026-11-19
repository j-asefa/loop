import { z } from "zod";

// What started a turn. Loop already stores this on the turn's first message
// (metadata.automation.kind), in code_reviews and in delegations; usage
// groups by it instead of guessing from the prompt text.
export const USAGE_ORIGINS = [
  "person",
  "review_continuation",
  "review_team",
  "delegation",
  "agent_message",
  "agent_result",
  "github_watch",
  "feed_digest",
  "automation",
] as const;
export const UsageOrigin = z.enum(USAGE_ORIGINS);
export type UsageOrigin = z.infer<typeof UsageOrigin>;

const LABELS: Record<UsageOrigin, string> = {
  person: "Your messages",
  review_continuation: "Review follow-ups",
  review_team: "Review team",
  delegation: "Delegated tasks",
  agent_message: "Agent messages",
  agent_result: "Agent results",
  github_watch: "GitHub updates",
  feed_digest: "Feed digests",
  automation: "Other automation",
};
export const usageOriginLabel = (origin: UsageOrigin) => LABELS[origin];

/**
 * The stored automation kind wins: it names what woke the turn. Kinds written
 * by earlier releases that this list does not name stay visible as
 * "automation" rather than being counted as a person's message.
 */
export function usageOrigin(turn: {
  automation: string | null;
  review: boolean;
  delegated: boolean;
}): UsageOrigin {
  if (turn.automation) {
    const known = UsageOrigin.safeParse(turn.automation);
    return known.success &&
      known.data !== "person" &&
      known.data !== "review_team" &&
      known.data !== "delegation"
      ? known.data
      : "automation";
  }
  if (turn.review) return "review_team";
  if (turn.delegated) return "delegation";
  return "person";
}
