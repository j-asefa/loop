/** The categories offered by Feed and by workspace Search. */
export const feedCategories = [
  { id: "done", label: "Done" },
  { id: "working", label: "Working" },
  { id: "queued", label: "Queued" },
  { id: "replies", label: "Replies" },
  { id: "threads", label: "Threads" },
] as const;

export type FeedCategory = (typeof feedCategories)[number]["id"];
