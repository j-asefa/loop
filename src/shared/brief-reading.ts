import type { ItemSummary } from "../server/briefs/schema.js";

export const briefStageLabels: Record<
  NonNullable<ItemSummary["stage"]>,
  string
> = {
  needs_review: "Ready for review",
  in_progress: "In progress",
  awaiting_update: "Waiting for an app update",
  waiting: "Waiting",
  on_main: "On main",
  done: "Done",
};
