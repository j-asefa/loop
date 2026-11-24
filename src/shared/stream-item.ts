import type { FeedEntry, SocialStory } from "./news.js";

/** External stream kinds that can appear in Loop's unified Feed. */
export type StreamItemKind = "rss" | "email";

export type StreamItemMedia = {
  url: string;
  type: string;
  seconds: number | null;
};

export type StreamItemMeta = {
  feedKind?: string;
  site?: string | null;
  community?: string | null;
  author?: string | null;
  points?: number | null;
  comments?: number | null;
  image?: string | null;
  media?: StreamItemMedia | null;
  color?: string;
  home?: string;
  mark?: FeedEntry["mark"];
};

export type StreamAgentPromptContext = {
  kind: StreamItemKind;
  sourceLabel: string;
  itemKindLabel: string;
  title: string;
  url: string | null;
  discussionUrl: string | null;
  excerpt: string | null;
};

/**
 * A non-agent item surfaced in Loop's unified Feed (RSS today, Email later).
 * Keys are namespaced by kind so items from different external sources never
 * collide with each other or with Done card keys.
 */
export type StreamItem = {
  id: string;
  rawId: string;
  kind: StreamItemKind;
  sourceId: string;
  sourceLabel: string;
  title: string;
  excerpt: string | null;
  url: string | null;
  discussionUrl: string | null;
  timestamp: number;
  read: boolean;
  highSignal: boolean;
  meta: StreamItemMeta;
  agentPromptContext: StreamAgentPromptContext;
};

/** Accepts only http(s) URLs; rejects javascript:, data:, or malformed links. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Maps a Social RSS/Atom/JSON Feed story into a unified StreamItem. */
export function socialStoryToStreamItem(
  story: SocialStory,
  feed: FeedEntry,
  options?: { highSignal?: boolean },
): StreamItem {
  const url = safeHttpUrl(story.url);
  const discussionUrl = safeHttpUrl(story.comments_url);
  const mediaUrl = safeHttpUrl(story.media?.url);
  const sourceLabel = story.community || feed.name;
  const itemKindLabel = feed.kind || "story";
  const excerpt = story.summary?.trim() ? story.summary.trim() : null;
  return {
    id: `rss:${story.id}`,
    rawId: story.id,
    kind: "rss",
    sourceId: story.feed,
    sourceLabel,
    title: story.title,
    excerpt,
    url,
    discussionUrl:
      discussionUrl && discussionUrl !== url ? discussionUrl : null,
    timestamp: story.published_at ?? story.first_seen_at,
    read: story.read,
    highSignal: Boolean(options?.highSignal),
    meta: {
      feedKind: itemKindLabel,
      site: story.site,
      community: story.community,
      author: story.author,
      points: story.points,
      comments: story.comments,
      image: story.image,
      media:
        story.media && mediaUrl
          ? {
              url: mediaUrl,
              type: story.media.type,
              seconds: story.media.seconds,
            }
          : null,
      color: feed.color,
      home: feed.home,
      mark: feed.mark,
    },
    agentPromptContext: {
      kind: "rss",
      sourceLabel: feed.name,
      itemKindLabel,
      title: story.title,
      url,
      discussionUrl:
        discussionUrl && discussionUrl !== url ? discussionUrl : null,
      excerpt,
    },
  };
}

/** Builds the default attribution-preserving prompt for "Ask an agent". */
export function defaultStreamAskPrompt(item: StreamItem): string {
  const ctx = item.agentPromptContext;
  const lines = [
    ctx.kind === "email"
      ? `About this email from ${ctx.sourceLabel}: ${ctx.title}`
      : `About this ${ctx.sourceLabel} ${ctx.itemKindLabel}: ${ctx.title}`,
  ];
  if (ctx.url) lines.push(ctx.url);
  if (ctx.discussionUrl && ctx.discussionUrl !== ctx.url)
    lines.push(`Discussion: ${ctx.discussionUrl}`);
  return `${lines.join("\n")}\n\n`;
}
