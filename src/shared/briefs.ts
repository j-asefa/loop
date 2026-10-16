import type { Brief, Change, Item } from "../server/briefs/schema.js";
import type { BriefGenerationUsage } from "./brief-usage.js";
export type { Brief, Change, Item };
export type BriefSource = {
  ref: string;
  kind?:
    | "result"
    | "message"
    | "saved"
    | "approval"
    | "pr"
    | "checkout"
    | "verification";
  run?: string;
  title: string;
  at: number | null;
  conversation: string | null;
  message: string | null;
  artifact: string | null;
  excerpt: string;
};
export type BriefEvidencePage = {
  text: string;
  cite: Item["cite"];
  sources: Record<string, BriefSource>;
};
export type BriefPage = Brief & {
  generation_usage?: BriefGenerationUsage | null;
  settings: {
    enabled: boolean;
    connectionId: string | null;
    model: string | null;
    lastError: string | null;
  };
  sources: Record<string, BriefSource>;
  attention: Record<string, { conversation: string; message: string | null }>;
  coverage: { results: number; threads: number; model: string | null };
};
export type BriefItems = {
  items: Item[];
  before: string | null;
  sources: Record<string, BriefSource>;
  replacements: Record<string, string>;
};
export type BriefVersion = { version: number; at: number; changes: Change[] };
