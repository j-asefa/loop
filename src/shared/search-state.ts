import { z } from "zod";

// The semantic search indexer's reported state and the mode a search run used,
// both written in src/server/search.ts (D1).
export const SearchIndexStates = [
  "disabled",
  "needs_connection",
  "preparing",
  "indexing",
  "ready",
  "error",
] as const;
export const SearchIndexState = z.enum(SearchIndexStates);
export type SearchIndexState = z.infer<typeof SearchIndexState>;

export const SearchModes = ["keyword", "hybrid"] as const;
export const SearchMode = z.enum(SearchModes);
export type SearchMode = z.infer<typeof SearchMode>;
