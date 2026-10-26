import { z } from "zod";

const Text = z.string();
const MaybeText = Text.nullable();
const Time = z.number();
// Express may produce repeated scalar query keys. Existing boolean flags only
// enable on exactly "1", so repeated keys continue to mean false.
const Flag = z.union([Text, z.array(Text)]).optional();
export const SocialQuery = z.object({
  refresh: Flag,
  wait: Flag,
  unread: Flag,
  muted: Flag,
});
export const SocialSearchQuery = z.object({
  q: Text.max(200).default(""),
  feed: Text.max(120).optional(),
  unread: Flag,
});
export const StoryIds = z.object({
  stories: z.array(Text.min(3).max(600)).max(200),
});
export const MuteInput = z.object({ phrase: Text.max(80) });
export const PreferenceInput = z.object({
  agent_access: z.boolean().optional(),
  images: z.boolean().optional(),
});
export const ReadAllInput = z
  .object({ feed: Text.max(120).optional() })
  .nullish();
export const SourceDiscoveryInput = z.object({ url: Text.min(8).max(2048) });
export const SourceInput = SourceDiscoveryInput.extend({
  title: Text.max(80).optional(),
  category: Text.max(40).optional(),
  kind: z.enum(["article", "post", "story", "video", "release"]).optional(),
});
// The production JSON parser accepts the existing { opml } envelope. Keep
// the original XML and the handler's coercion without parsing the document.
export const OpmlInput = z
  .object({ opml: z.coerce.string().max(1_000_000).nullish() })
  .nullish();
export const WatchInput = z.object({
  query: Text.min(2).max(200),
  feeds: z.array(Text.min(1).max(120)).max(200).nullish(),
  enabled: z.boolean().default(true),
});
export const DigestInput = z.object({
  agentId: Text.min(1).max(150),
  conversationId: Text.min(1).max(150).nullish(),
  feeds: z.array(Text.min(1).max(120)).max(200).nullish(),
  minuteOfDay: z.number().int().min(0).max(1439),
  zone: Text.min(1).max(60),
  unreadOnly: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

export const PublicSocialStory = z.object({
  id: Text,
  title: Text,
  url: Text,
  site: MaybeText,
  comments_url: MaybeText,
  published_at: Time.nullable(),
  community: MaybeText,
  author: MaybeText,
  points: z.number().nullable(),
  comments: z.number().nullable(),
  summary: MaybeText,
  image: MaybeText,
  media: z
    .object({ url: Text, type: Text, seconds: z.number().nullable() })
    .nullable(),
  feed: Text,
  first_seen_at: Time,
  read: z.boolean(),
});
export const PublicFeedHealth = z.object({
  id: Text,
  fetched_at: Time.nullable(),
  failed_at: Time.nullable(),
  error: MaybeText,
  stories: z.number(),
});
export const PublicSocial = z.object({
  stories: z.array(PublicSocialStory),
  failed: z.array(Text),
  pending: z.array(Text),
  fetched_at: Time,
  feeds: z.array(PublicFeedHealth),
  unread: z.number(),
  hidden: z.number(),
});
export const PublicFeedEntry = z.object({
  id: Text,
  name: Text,
  category: Text,
  description: Text,
  home: Text,
  url: Text,
  color: Text,
  kind: Text,
  mark: z.enum(["hn", "reddit", "github", "youtube"]).optional(),
});
export const PublicPreferences = z.object({
  agent_access: z.boolean(),
  images: z.boolean(),
  mutes: z.array(Text),
});
export const PublicWatch = z.object({
  id: Text,
  owner_id: Text,
  query: Text,
  feeds: MaybeText,
  created_at: Time,
  since_at: Time,
  enabled: z.number(),
  matches: z.number(),
  last_match_at: Time.nullable(),
});
export const PublicWatchPreview = z.object({
  stories: z.array(
    z.object({
      feed: Text,
      title: Text,
      url: Text,
      published_at: Time.nullable(),
    }),
  ),
});
export const PublicDigest = z.object({
  id: Text,
  owner_id: Text,
  agent_id: Text,
  conversation_id: MaybeText,
  feeds: MaybeText,
  minute_of_day: z.number(),
  zone: Text,
  unread_only: z.number(),
  enabled: z.number(),
  last_run_at: Time.nullable(),
  last_error: MaybeText,
  created_at: Time,
});
