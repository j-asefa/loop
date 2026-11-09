import { Problem } from "../shared/problem.js";
import type { NewsStory } from "../shared/news.js";

// One reader for every public feed format in use: RSS 2.0 (and 0.9x), RSS 1.0
// (RDF), Atom and JSON Feed. Each item becomes a NewsStory, so any feed shows
// as the same Feed cards. A short table of site extras adds what only a few
// feeds carry, such as Hacker News points or the article behind a Reddit post.

const MAX_STORIES = 50;
const MAX_TITLE = 300;
const MAX_SUMMARY = 280;

type ParsedFeed = {
  /** The feed's own title, such as "Hacker News" or a blog's name. */
  title: string | null;
  /** The site the feed belongs to. */
  home: string | null;
  stories: NewsStory[];
};

// XML defines five entities; the rest turn up in escaped HTML content.
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
};
function decode(text: string) {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name[0] !== "#") return entities[name.toLowerCase()] ?? whole;
      const code =
        name[1].toLowerCase() === "x"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}
// Feeds are untrusted and up to 2 MB, so markup is found by scanning forward
// once: each search for a closing tag starts where the last one ended, and
// once a closing tag is missing no later opening tag can be closed either.
// A lazy regex such as /<item>([\s\S]*?)<\/item>/ instead rescans the rest
// of the document from every unclosed opening tag.

/** Removes each opening…closing span; an unclosed span is kept. */
function drop(text: string, open: RegExp, close: RegExp) {
  let kept = "";
  let at = 0;
  open.lastIndex = 0;
  for (let start; (start = open.exec(text));) {
    close.lastIndex = open.lastIndex;
    if (!close.exec(text)) break;
    kept += text.slice(at, start.index);
    at = open.lastIndex = close.lastIndex;
  }
  return kept + text.slice(at);
}
const dropComments = (text: string) => drop(text, /<!--/g, /-->/g);

/** An element's content: entities decoded, CDATA sections kept as written. */
function inner(raw: string) {
  let content = "";
  let at = 0;
  for (let start; (start = raw.indexOf("<![CDATA[", at)) >= 0;) {
    const end = raw.indexOf("]]>", start + 9);
    if (end < 0) break;
    content += decode(raw.slice(at, start)) + raw.slice(start + 9, end);
    at = end + 3;
  }
  return (content + decode(raw.slice(at))).trim();
}
const escapeHtml = (text: string) =>
  text.replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!,
  );
/** Readable text from an HTML fragment. */
function plain(html: string) {
  let markup = dropComments(html);
  for (const tag of ["script", "style"])
    markup = drop(
      markup,
      new RegExp(`<${tag}\\b`, "gi"),
      new RegExp(`</${tag}\\s*>`, "gi"),
    );
  return decode(markup.replace(/<[a-z/!][^<>]*>/gi, " "))
    .replace(/\s+/g, " ")
    .trim();
}
// Titles are text, but feeds often escape them twice or wrap words in markup.
function cleanTitle(text: string) {
  return decode(
    text.replace(/<\/?(a|b|i|em|strong|code|span|sup|sub|br)\b[^<>]*>/gi, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}
function clip(text: string, length: number) {
  if (text.length <= length) return text;
  const cut = text.slice(0, length - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), length * 0.6)).trimEnd()}…`;
}

type Element = { attrs: string; raw: string; at: number };
const escapeTag = (tag: string) => tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Each <tag …>…</tag> or <tag …/> in order, up to a limit. An opening tag
 * with no closing tag after it is skipped, as are any more like it, but a
 * later self-closing one is still found.
 */
export function elements(block: string, tag: string, limit = Infinity) {
  const name = escapeTag(tag);
  const open = new RegExp(`<${name}(?=[\\s/>])`, "gi");
  const close = new RegExp(`</${name}\\s*>`, "gi");
  const found: Element[] = [];
  // The next ">" and closing tag, which only move forward.
  let end = -1;
  let closing: { start: number; end: number } | null = { start: -1, end: 0 };
  for (let start; found.length < limit && (start = open.exec(block));) {
    if (end < open.lastIndex) end = block.indexOf(">", open.lastIndex);
    if (end < 0) break;
    const attrs = block.slice(open.lastIndex, end);
    if (attrs.endsWith("/")) {
      found.push({
        attrs: attrs.slice(0, -1).trimEnd(),
        raw: "",
        at: start.index,
      });
      open.lastIndex = end + 1;
      continue;
    }
    if (closing && closing.start <= end) {
      close.lastIndex = end + 1;
      const match = close.exec(block);
      closing = match && { start: match.index, end: close.lastIndex };
    }
    if (!closing) continue;
    found.push({
      attrs: attrs.trimEnd(),
      raw: block.slice(end + 1, closing.start),
      at: start.index,
    });
    open.lastIndex = closing.end;
  }
  return found;
}
const element = (block: string, tag: string) =>
  elements(block, tag, 1)[0] as Element | undefined;
/** The text of the first of these elements that has any. */
function text(block: string, ...tags: string[]) {
  for (const tag of tags) {
    const value = element(block, tag);
    const content = value ? inner(value.raw) : "";
    if (content) return content;
  }
  return "";
}
export function attribute(attrs: string, name: string) {
  const match = attrs.match(
    new RegExp(
      `(?:^|\\s)${escapeTag(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
      "i",
    ),
  );
  return match ? decode(match[1] ?? match[2]).trim() : "";
}
// Links come from a third party: only web links are ever rendered.
function webUrl(value: unknown, base?: string) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
const host = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
function date(value: unknown) {
  const at = typeof value === "string" ? Date.parse(value.trim()) : NaN;
  return Number.isFinite(at) ? at : null;
}
function count(value: unknown) {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return value !== "" && Number.isInteger(n) && n >= 0 ? n : null;
}
// RSS authors are often "someone@example.com (Name)"; show the name, never a
// bare address.
function person(value: string) {
  const named = value.match(/\(([^()]+)\)\s*$/);
  const name = (named ? named[1] : value).replace(/\s+/g, " ").trim();
  // Two tests, not /^\S+@\S+$/, which backtracks badly over "a@a@a@…".
  return /^\S+$/.test(name) && /.@./.test(name) ? null : clip(name, 60) || null;
}

/** A feed item, read without knowing which site it came from. */
type Draft = {
  id: string;
  title: string;
  url: string | null;
  comments_url: string | null;
  published_at: number | null;
  community: string | null;
  author: string | null;
  points: number | null;
  comments: number | null;
  summary: string;
  image: string | null;
  media: NewsStory["media"];
  /** The item's raw markup, for site extras. */
  source: string;
  /** The item's HTML body, for site extras. */
  body: string;
};

// A feed's own picture for an item, and an audio or video file it attached.
// Only web addresses are kept, and an image must be https: a page served over
// https cannot load an http picture anyway, so a broken box is all it would be.
const picture = (value: string | null, base?: string) => {
  const url = webUrl(value, base);
  return url?.startsWith("https:") ? url : null;
};
const seconds = (value: unknown) => {
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const playable = (type: string) => /^(audio|video)\//i.test(type);

/** The picture a feed offered: a thumbnail, an image enclosure, or the body's. */
function imageOf(item: string, body: string, base: string) {
  for (const tag of ["media:thumbnail", "media:content", "itunes:image"]) {
    for (const { attrs } of elements(item, tag)) {
      const type = attribute(attrs, "type");
      const medium = attribute(attrs, "medium").toLowerCase();
      if (type && !/^image\//i.test(type)) continue;
      if (medium && medium !== "image") continue;
      const found = picture(
        attribute(attrs, "url") || attribute(attrs, "href"),
        base,
      );
      if (found) return found;
    }
  }
  for (const { attrs } of elements(item, "enclosure"))
    if (/^image\//i.test(attribute(attrs, "type"))) {
      const found = picture(attribute(attrs, "url"), base);
      if (found) return found;
    }
  // Last resort: the first picture in the item's own markup.
  const inline = body.match(/<img\b[^<>]*?\bsrc\s*=\s*"([^"]+)"/i);
  return inline ? picture(decode(inline[1]), base) : null;
}

/** An audio or video file a feed attached: a podcast episode, or a video. */
function mediaOf(item: string, base: string): NewsStory["media"] {
  for (const { attrs } of [
    ...elements(item, "enclosure"),
    ...elements(item, "media:content"),
  ]) {
    const type = attribute(attrs, "type");
    if (!playable(type)) continue;
    const url = webUrl(attribute(attrs, "url"), base);
    if (!url) continue;
    return {
      url,
      type: type.slice(0, 60),
      seconds:
        seconds(attribute(attrs, "duration")) ??
        seconds(text(item, "itunes:duration")),
    };
  }
  return null;
}

function rssItem(item: string, base: string): Draft {
  const body = text(item, "content:encoded", "description");
  const guid = element(item, "guid");
  const guidText = guid ? inner(guid.raw) : "";
  const permalink =
    guid && attribute(guid.attrs, "isPermaLink").toLowerCase() !== "false"
      ? webUrl(guidText, base)
      : null;
  const about = attribute(item.match(/^[^>]*/)?.[0] || "", "rdf:about");
  const url =
    webUrl(text(item, "feedburner:origLink"), base) ||
    webUrl(text(item, "link"), base) ||
    permalink ||
    webUrl(about, base);
  const comments_url = webUrl(text(item, "comments"), base);
  return {
    id: guidText || about,
    title: cleanTitle(text(item, "title")),
    url,
    comments_url,
    published_at: date(text(item, "pubDate", "dc:date", "a10:updated")),
    community: null,
    author: person(text(item, "dc:creator", "author", "itunes:author")),
    points: null,
    comments: count(text(item, "slash:comments")),
    // The description is the excerpt; content:encoded is often the whole post.
    summary: text(item, "description") || body,
    image: imageOf(item, body, base),
    media: mediaOf(item, base),
    source: item,
    body,
  };
}

function atomText(entry: string, tag: string) {
  const value = element(entry, tag);
  if (!value) return "";
  const type = attribute(value.attrs, "type").toLowerCase();
  const content = inner(value.raw);
  // type="html" is escaped markup, type="xhtml" inline markup; both are HTML.
  return type === "html" || type === "xhtml" || type.endsWith("html")
    ? content
    : escapeHtml(content);
}
function atomLinks(block: string, base: string) {
  return elements(block, "link").map(({ attrs }) => ({
    rel: attribute(attrs, "rel").toLowerCase() || "alternate",
    type: attribute(attrs, "type").toLowerCase(),
    href: webUrl(attribute(attrs, "href"), base),
    count: count(attribute(attrs, "thr:count")),
  }));
}
const htmlLink = (type: string) => !type || type.includes("html");

function atomEntry(entry: string, base: string): Draft {
  const links = atomLinks(entry, base);
  const alternate = links.find(
    (link) => link.rel === "alternate" && link.href && htmlLink(link.type),
  );
  const replies = links.find(
    (link) => link.rel === "replies" && link.href && htmlLink(link.type),
  );
  const body = atomText(entry, "content") || atomText(entry, "summary");
  const author = element(entry, "author");
  return {
    id: text(entry, "id"),
    title: cleanTitle(atomText(entry, "title")),
    url: alternate?.href || links.find((link) => link.href)?.href || null,
    comments_url: replies?.href || null,
    published_at: date(
      text(entry, "published", "issued", "updated", "modified"),
    ),
    community: null,
    author: author ? person(cleanTitle(text(author.raw, "name"))) : null,
    points: null,
    comments: count(text(entry, "thr:total")) ?? replies?.count ?? null,
    summary:
      atomText(entry, "summary") ||
      body ||
      escapeHtml(text(entry, "media:description")),
    image: imageOf(entry, body, base),
    media:
      mediaOf(entry, base) ||
      // Atom attaches media with rel="enclosure" rather than <enclosure>.
      links
        .filter((link) => link.rel === "enclosure" && link.href)
        .map((link) =>
          playable(link.type)
            ? { url: link.href!, type: link.type.slice(0, 60), seconds: null }
            : null,
        )
        .find(Boolean) ||
      null,
    source: entry,
    body,
  };
}

function jsonItem(item: any, base: string): Draft {
  const own = webUrl(item?.url, base);
  const external = webUrl(item?.external_url, base);
  const authors = Array.isArray(item?.authors) ? item.authors : [item?.author];
  const author = authors.find((who: any) => typeof who?.name === "string");
  const body =
    typeof item?.content_html === "string"
      ? item.content_html
      : typeof item?.content_text === "string"
        ? escapeHtml(item.content_text)
        : "";
  return {
    id: item?.id == null ? "" : String(item.id),
    title: typeof item?.title === "string" ? cleanTitle(item.title) : "",
    // A link post's own page is where people discuss it.
    url: external || own,
    comments_url: external && own !== external ? own : null,
    published_at: date(item?.date_published) ?? date(item?.date_modified),
    community: null,
    author: author ? person(author.name) : null,
    points: null,
    comments: null,
    summary: typeof item?.summary === "string" ? item.summary : body,
    image:
      picture(item?.image, base) ||
      picture(item?.banner_image, base) ||
      attachment(item, /^image\//i, base)?.url ||
      null,
    media: attachment(item, /^(audio|video)\//i, base),
    source: "",
    body,
  };
}

/** A JSON Feed attachment of a kind, as a media entry. */
function attachment(item: any, kind: RegExp, base: string) {
  const list = Array.isArray(item?.attachments) ? item.attachments : [];
  for (const found of list) {
    const type = typeof found?.mime_type === "string" ? found.mime_type : "";
    if (!kind.test(type)) continue;
    const url = type.toLowerCase().startsWith("image/")
      ? picture(found?.url, base)
      : webUrl(found?.url, base);
    if (url) {
      if (type.startsWith("image/")) return { url, type, seconds: null };
      return {
        url,
        type: type.slice(0, 60),
        seconds: seconds(found?.duration_in_seconds),
      };
    }
  }
  return null;
}

/**
 * What a few well-known feeds add beyond the formats. Each extra matches on
 * the feed's own host and only fills in or corrects fields.
 */
const extras: { feeds: RegExp; apply: (draft: Draft) => void }[] = [
  {
    // Hacker News (and hnrss.org) put the points and comment count in the
    // description, which is otherwise just links back to the item.
    feeds: /^(news\.ycombinator\.com|hnrss\.org)$/,
    apply(draft) {
      const description = plain(text(draft.source, "description"));
      const number = (label: string) =>
        count(description.match(new RegExp(`${label}:\\s*(\\d+)`, "i"))?.[1]);
      draft.points = number("Points");
      draft.comments = number("# Comments") ?? draft.comments;
      const id =
        draft.comments_url &&
        new URL(draft.comments_url).searchParams.get("id");
      if (id) draft.id = id;
      draft.summary = "";
    },
  },
  {
    // Reddit links each entry to its comments; the article, if any, is the
    // body's "[link]", and the subreddit is the category.
    feeds: /(^|\.)reddit\.com$/,
    apply(draft) {
      const linked = draft.body.match(/<a href="([^"]+)">\s*\[link\]\s*<\/a>/i);
      draft.comments_url = draft.url;
      draft.url = (linked && webUrl(decode(linked[1]))) || draft.url;
      const category = element(draft.source, "category");
      const term = category ? attribute(category.attrs, "term") : "";
      draft.community =
        (category && attribute(category.attrs, "label")) ||
        (term && `r/${term}`) ||
        null;
      draft.author = draft.author?.replace(/^\/u\//, "u/") || null;
      // Keep a self post's text, not the "submitted by … [link] [comments]".
      draft.summary = draft.body.replace(/submitted by[\s\S]*$/i, "");
    },
  },
];

function finish(drafts: Draft[], home: string | null, feedUrl: string) {
  const stories: NewsStory[] = [];
  const seen = new Set<string>();
  // Posts that live on the feed's own site have no separate "site" to show.
  const ownHosts = new Set([host(home), host(feedUrl)].filter(Boolean));
  const extra = extras.find(({ feeds }) => feeds.test(host(feedUrl) || ""));
  for (const draft of drafts) {
    extra?.apply(draft);
    const url = draft.url || draft.comments_url;
    if (!url) continue;
    let summary = plain(draft.summary);
    // Some feeds' only description is a link back to the discussion.
    if (
      /^(comments?|link|permalink|read more|continue reading)\W*$/i.test(
        summary,
      )
    )
      summary = "";
    let title = draft.title;
    // Microblog posts (Mastodon, Bluesky) have no title: the text is the title.
    if (!title) {
      if (!summary) continue;
      [title, summary] = [summary, ""];
    }
    if (summary === title) summary = "";
    const id = (draft.id || draft.comments_url || url).slice(0, 500);
    if (seen.has(id)) continue;
    seen.add(id);
    const site = host(url);
    stories.push({
      id,
      title: clip(title, MAX_TITLE),
      url,
      site:
        site && !ownHosts.has(site) && url !== draft.comments_url ? site : null,
      comments_url: draft.comments_url,
      published_at: draft.published_at,
      community: draft.community?.slice(0, 60) || null,
      author: draft.author,
      points: draft.points,
      comments: draft.comments,
      summary: summary ? clip(summary, MAX_SUMMARY) : null,
      image: draft.image,
      media: draft.media,
    });
    if (stories.length >= MAX_STORIES) break;
  }
  return stories;
}

/**
 * Reads any RSS, Atom or JSON Feed document into Feed stories, in feed order.
 * Relative links resolve against the feed's own address.
 */
export function parseFeed(document: string, feedUrl: string): ParsedFeed {
  const trimmed = document.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{")) {
    let json: any;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new Problem(400, "This isn’t a feed: it isn’t valid JSON.");
    }
    if (!Array.isArray(json?.items))
      throw new Problem(400, "This isn’t a feed: it has no items.");
    const home = webUrl(json.home_page_url, feedUrl);
    return {
      title:
        typeof json.title === "string" ? cleanTitle(json.title) || null : null,
      home,
      stories: finish(
        json.items
          .slice(0, MAX_STORIES * 2)
          .map((item: any) => jsonItem(item, feedUrl)),
        home,
        feedUrl,
      ),
    };
  }
  const xml = dropComments(trimmed);
  const atom = /<feed[\s>]/i.test(xml) && !/<(rss|rdf:RDF)[\s>]/i.test(xml);
  if (!atom && !/<(rss|rdf:RDF|channel)[\s>]/i.test(xml))
    throw new Problem(400, "This isn’t an RSS, Atom or JSON feed.");
  const items = elements(xml, atom ? "entry" : "item", MAX_STORIES * 2);
  const head = xml.slice(0, items[0]?.at ?? xml.length);
  const home = atom
    ? atomLinks(head, feedUrl).find(
        (link) => link.rel === "alternate" && link.href,
      )?.href || null
    : webUrl(text(element(head, "channel")?.raw || head, "link"), feedUrl);
  return {
    title:
      cleanTitle(atom ? plain(atomText(head, "title")) : text(head, "title")) ||
      null,
    home,
    stories: finish(
      items.map(({ attrs, raw }) =>
        atom ? atomEntry(raw, feedUrl) : rssItem(`${attrs}>${raw}`, feedUrl),
      ),
      home,
      feedUrl,
    ),
  };
}
