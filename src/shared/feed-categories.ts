/** The categories offered by Feed and by workspace Search. */
export const feedCategories = [
  { id: "done", label: "Done" },
  { id: "working", label: "Working" },
  { id: "queued", label: "Queued" },
  { id: "replies", label: "Replies" },
  { id: "threads", label: "Threads" },
] as const;

export type FeedCategory = (typeof feedCategories)[number]["id"];

export const FEED_FILTERS = [
  "all",
  "done",
  "replies",
  "needs",
  "working",
  "queued",
  "later",
  "outcomes",
  "unfinished",
] as const;

export type FeedFilter = (typeof FEED_FILTERS)[number];
// Threads is a client aggregation; Needs and Later have their own surfaces.
export type FeedView = Exclude<FeedFilter, "needs" | "later"> | "threads";
