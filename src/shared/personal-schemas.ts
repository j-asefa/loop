import { z } from "zod";

const Text = z.string(), MaybeText = Text.nullable();
export const PublicProfile = z.object({
  display_name: MaybeText, handle: MaybeText, bio: MaybeText,
  counts: z.object({ messages: z.number(), agents: z.number(), projects: z.number() }),
});

// Empty text clears a field; keep the profile service's existing normalization.
const optionalText = (max: number) => Text.trim().max(max).transform(value => value || null).nullable();
export const ProfileInput = z.object({
  display_name: optionalText(80),
  handle: Text.trim()
    .transform(value => value.replace(/^@/, "").toLowerCase())
    .refine(value => !value || /^[a-z0-9_]{2,30}$/.test(value), "Use 2–30 letters, numbers or underscores for your handle")
    .transform(value => value || null).nullable(),
  bio: optionalText(200),
});
export const PersonalPromptsQuery = z.object({
  before: Text.min(1).max(512).optional(), q: Text.trim().max(200).optional(),
});
export const PersonalPromptsPage = z.object({
  items: z.array(z.object({
    id: Text, content: Text, created_at: z.number(), conversation_id: Text,
    // The service already parses stored JSON. Older attachments can lack newer
    // upload fields; this is an opaque history value, not a new upload request.
    attachments: z.json(), conversation_title: Text, agent_name: MaybeText,
    provider: MaybeText, agent_id: MaybeText, project_name: MaybeText,
  })),
  next: MaybeText,
});
