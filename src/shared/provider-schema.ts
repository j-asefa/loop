import { z } from "zod";

export const ProviderSchema = z.enum(["openai", "anthropic", "codex", "pi", "opencode", "gemini", "muse", "grok", "acp"]);
