import { z } from "zod";

export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "codex",
  "pi",
  "opencode",
  "antigravity",

  "muse",
  "grok",
  "acp",
]);
