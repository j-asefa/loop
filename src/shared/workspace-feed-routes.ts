import { FEED_FILTERS } from "./feed-categories.js";
import { z } from "zod";
import { Text, NumberCursor, endpoint, base } from "./route-contract.js";
import {
  Bootstrap,
  FeedPage,
  ResultsPage,
  ResultsUpdates,
  Teams,
  ResultSelection,
} from "./workspace-contract-schemas.js";

export const workspaceFeedRoutes = {
  bootstrap: endpoint({
    ...base,
    operation: "bootstrap",
    access: { admits: ["read"] },
    method: "GET",
    path: "/bootstrap",
    response: Bootstrap,
  }),
  feed: endpoint({
    ...base,
    operation: "feed",
    access: { admits: ["read"] },
    method: "GET",
    path: "/feed",
    query: z.object({
      filter: z.enum(FEED_FILTERS).default("all"),
      folder: Text.min(1).max(150).optional(),
      agent: Text.min(1).max(150).optional(),
      before: Text.min(1).max(512).optional(),
      teams: Teams,
      known: Text.optional(),
    }),
    response: FeedPage,
  }),
  results: endpoint({
    ...base,
    operation: "results",
    access: { admits: ["read"] },
    method: "GET",
    path: "/results",
    query: z.object({
      ...ResultSelection,
      view: Text.optional(),
      saved: Text.optional(),
      before: z.coerce.number<string>().min(0).catch(0).default(0),
    }),
    response: ResultsPage,
  }),
  resultUpdates: endpoint({
    ...base,
    operation: "resultUpdates",
    access: { admits: ["read"] },
    method: "GET",
    path: "/results/updates",
    query: z.object({
      ...ResultSelection,
      after: NumberCursor,
      through: NumberCursor,
    }),
    response: ResultsUpdates,
  }),
} as const;
