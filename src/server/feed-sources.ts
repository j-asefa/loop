import { collapse } from "./collapse.js";
import * as feedSourcesQueries from "./sql/feed-sources.js";
import * as feedReadsQueries from "./sql/feed-reads.js";
import * as feedDismissalsQueries from "./sql/feed-dismissals.js";
import {
  SourceInput,
  SourceDiscoveryInput,
} from "../shared/social-contract-schemas.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, now } from "./db.js";
import { Problem } from "./domain.js";
import { download, feedUrl, pageText } from "./feed-fetch.js";
import { attribute } from "./syndication.js";
import { feedById, type FeedEntry } from "../shared/news.js";

// Feeds an owner added themselves. The catalog in src/shared/news.ts is
// checked in and was read before it was listed; an address someone types has
// no such warrant, so it is validated here before it is ever requested:
// public HTTPS only, no credentials, no private or loopback destination. The
// request itself then goes through the same transport as a catalog feed
// (feed-fetch.ts), which resolves DNS through a public-only dispatcher,
// follows redirects only within the feed's own site and caps what it reads.

/** Feeds one owner may add. A reader's whole subscription list fits inside. */
const PER_OWNER = 200;
const MAX_TITLE = 80;
/** Outlines read from one OPML document, and how much of it is read. */
const MAX_OUTLINES = 500;
const MAX_OPML_BYTES = 1_000_000;
/** Feeds offered for a page that is not itself a feed. */
const MAX_CANDIDATES = 10;
const OWN_CATEGORY = "Your feeds";

// The tile colour behind a feed's initial, from its host, so the same site is
// always the same colour and two added feeds rarely look alike.
const COLORS = [
  "#4a6b8a",
  "#ac130d",
  "#0a8935",
  "#5200ff",
  "#d5683a",
  "#1f2e5c",
  "#026664",
  "#b31b1b",
  "#2f6f9f",
  "#7b3f00",
];

/** The id a feed address gets, shared by every owner who adds it. */
export const sourceId = (url: URL) =>
  "user:" + createHash("sha256").update(url.href).digest("hex").slice(0, 32);

const asEntry = (row: SourceRow): FeedEntry => ({
  id: row.id,
  name: row.title,
  category: row.category,
  description: `A feed you added from ${row.home}.`,
  home: row.home,
  url: row.url,
  color: row.color,
  kind: row.kind,
});

type SourceRow = {
  id: string;
  owner_id: string;
  url: string;
  title: string;
  home: string;
  category: string;
  kind: string;
  color: string;
  created_at: number;
};

/** The feeds this owner added by URL, oldest first. */
export function ownSources(owner: string): FeedEntry[] {
  return feedSourcesQueries.forOwner(db, owner).map(asEntry);
}

export function ownSource(owner: string, id: string) {
  const row = feedSourcesQueries.owned(db, owner, id);
  return row ? asEntry(row) : null;
}

const title = (value: string | null | undefined, url: URL) =>
  collapse(value, MAX_TITLE) || url.hostname.replace(/^www\./, "");

const siteOf = (url: URL) => url.hostname.replace(/^(www|feeds|rss)\./, "");

/** Reads a feed once to name it, then keeps it for this owner. */
export async function addSource(owner: string, body: unknown) {
  const input = SourceInput.parse(body);
  const url = feedUrl(input.url);
  const id = sourceId(url);
  if (feedById.has(id)) throw new Problem(409, "That feed is in the catalog.");
  const existing = ownSource(owner, id);
  if (existing) return existing;
  const count = feedSourcesQueries.count(db, owner)!;
  if (count.n >= PER_OWNER)
    throw new Problem(
      400,
      `You can follow ${PER_OWNER} feeds of your own. Remove one first.`,
    );
  const entry: FeedEntry = {
    id,
    name: input.title || url.hostname,
    category: input.category?.trim() || OWN_CATEGORY,
    description: "",
    home: siteOf(url),
    url: url.href,
    color: COLORS[Number("0x" + id.slice(5, 9)) % COLORS.length],
    kind: input.kind || "post",
  };
  // Read it before keeping it, so a mistyped address is refused here rather
  // than becoming a feed that never loads.
  const answer = await download(entry);
  const read = answer.modified ? answer : null;
  const row: SourceRow = {
    id,
    owner_id: owner,
    url: url.href,
    title: input.title || title(read?.title, url),
    home: read?.home ? siteOf(new URL(read.home)) : entry.home,
    category: entry.category,
    kind: entry.kind,
    color: entry.color,
    created_at: now(),
  };
  return db
    .transaction(() => {
      // Recheck after downloading: another request may have followed this feed.
      const existing = ownSource(owner, id);
      if (existing) return existing;
      const count = feedSourcesQueries.count(db, owner)!;
      if (count.n >= PER_OWNER)
        throw new Problem(
          400,
          `You can follow ${PER_OWNER} feeds of your own. Remove one first.`,
        );
      feedSourcesQueries.insert(db, row);
      return ownSource(owner, id)!;
    })
    .immediate();
}

export function removeSource(owner: string, id: string) {
  const changes = feedSourcesQueries.remove(db, owner, id).changes;
  if (!changes) throw new Problem(404, "No such feed.");
  feedReadsQueries.removeOwnerFeed(db, owner, id);
  feedDismissalsQueries.removeOwnerFeed(db, owner, id);
}

/**
 * What feed a page offers, for someone who pasted a site rather than a feed.
 * One request: the candidates themselves are not read until one is added.
 */
export async function discover(body: unknown) {
  const { url: asked } = SourceDiscoveryInput.parse(body);
  const url = feedUrl(asked);
  const entry: FeedEntry = {
    id: sourceId(url),
    name: url.hostname,
    category: OWN_CATEGORY,
    description: "",
    home: siteOf(url),
    url: url.href,
    color: COLORS[0],
    kind: "post",
  };
  try {
    const answer = await download(entry);
    if (answer.modified)
      return {
        candidates: [{ url: url.href, title: title(answer.title, url) }],
      };
  } catch (error) {
    // Not a feed: read the page for the feeds it advertises instead, and say
    // what was wrong with the address if it offers none.
    const candidates = feedLinks(await pageText(url.href), url);
    if (!candidates.length) throw error;
    return { candidates };
  }
  return { candidates: [] };
}

/**
 * Each `<link …>` in a page's head. `link` is a void element in HTML — no
 * closing tag and often no slash — so the feed scanner, which pairs opening
 * and closing tags, does not see them. This walks forward once instead.
 */
function linkTags(markup: string) {
  const found: string[] = [];
  for (let at = 0; found.length < 200;) {
    const start = markup.indexOf("<link", at);
    if (start < 0) break;
    const end = markup.indexOf(">", start);
    if (end < 0) break;
    // "<linkedin" is not a <link>.
    if (/^[\s/>]/.test(markup[start + 5] || ">"))
      found.push(markup.slice(start + 5, end).replace(/\/$/, ""));
    at = end + 1;
  }
  return found;
}

/** `<link rel="alternate" type="application/rss+xml">` in a page's markup. */
function feedLinks(markup: string, base: URL) {
  const found: { url: string; title: string }[] = [];
  for (const attrs of linkTags(markup.slice(0, 200_000))) {
    if (attribute(attrs, "rel").toLowerCase() !== "alternate") continue;
    const type = attribute(attrs, "type").toLowerCase();
    if (!/(rss|atom|feed)\+?(xml|json)?$/.test(type)) continue;
    const href = attribute(attrs, "href");
    if (!href) continue;
    let candidate: URL;
    try {
      candidate = feedUrl(new URL(href, base).href);
    } catch {
      continue;
    }
    if (found.some((other) => other.url === candidate.href)) continue;
    found.push({
      url: candidate.href,
      title: attribute(attrs, "title") || title(null, candidate),
    });
    if (found.length >= MAX_CANDIDATES) break;
  }
  return found;
}

/** Every opening outline, independent of folders and closing-tag spelling. */
function outlines(markup: string): string[] {
  const found: string[] = [];
  // Advance once through the input. An unterminated comment/CDATA consumes
  // the remainder instead of restarting an unbounded scan at every '<'.
  let at = 0;
  while (at < markup.length && found.length < MAX_OUTLINES) {
    const start = markup.indexOf("<", at);
    if (start < 0) break;
    const terminator = markup.startsWith("<!--", start)
      ? "-->"
      : markup.startsWith("<![CDATA[", start)
        ? "]]>"
        : null;
    if (terminator) {
      const end = markup.indexOf(terminator, start + 4);
      if (end < 0) break;
      at = end + terminator.length;
      continue;
    }
    let quote = "",
      end = start + 1;
    for (; end < markup.length; end++) {
      const c = markup[end];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (end === markup.length) break;
    const tag = markup.slice(start, end + 1);
    const opening = /^<outline(?=\s|\/?>)([\s\S]*?)\/?>$/i.exec(tag);
    if (opening) found.push(opening[1]);
    at = end + 1;
  }
  return found;
}

/**
 * An OPML subscription list from another reader. Addresses are validated, but
 * nothing is read here: a list of three hundred feeds would otherwise be three
 * hundred requests. The worker reads each on its next pass, and a feed that
 * turns out not to be one says so there.
 */
export function importOpml(owner: string, document: unknown) {
  const text = z.string().max(MAX_OPML_BYTES).parse(document);
  const added: string[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const found = outlines(text);
  const have = new Set(feedSourcesQueries.ids(db, owner).map((row) => row.id));
  for (const attrs of found) {
    const address = attribute(attrs, "xmlUrl");
    if (!address) continue;
    let url: URL;
    try {
      url = feedUrl(address);
    } catch (error) {
      skipped.push({ url: address, reason: (error as Error).message });
      continue;
    }
    const id = sourceId(url);
    if (have.has(id) || feedById.has(id)) {
      skipped.push({ url: url.href, reason: "Already added." });
      continue;
    }
    if (have.size >= PER_OWNER) {
      skipped.push({ url: url.href, reason: "You have too many feeds." });
      continue;
    }
    const name = title(
      attribute(attrs, "title") || attribute(attrs, "text"),
      url,
    );
    feedSourcesQueries.insertIfAbsent(
      db,
      id,
      owner,
      url.href,
      name,
      siteOf(url),
      attribute(attrs, "category").slice(0, 40) || OWN_CATEGORY,
      "post",
      COLORS[Number("0x" + id.slice(5, 9)) % COLORS.length],
      now(),
    );
    have.add(id);
    added.push(url.href);
  }
  return { added: added.length, skipped };
}

const escapeAttribute = (value: string) =>
  value.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** This owner's feeds as OPML, catalog and added alike, grouped by category. */
export function exportOpml(owner: string, catalog: FeedEntry[]) {
  const feeds = [...catalog, ...ownSources(owner)];
  const groups = new Map<string, FeedEntry[]>();
  for (const feed of feeds)
    groups.set(feed.category, [...(groups.get(feed.category) || []), feed]);
  const outline = (feed: FeedEntry) =>
    `      <outline type="rss" text="${escapeAttribute(
      feed.name,
    )}" title="${escapeAttribute(feed.name)}" xmlUrl="${escapeAttribute(
      feed.url,
    )}" htmlUrl="${escapeAttribute("https://" + feed.home)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Loop feeds</title></head>
  <body>
${[...groups]
  .map(
    ([category, entries]) =>
      `    <outline text="${escapeAttribute(category)}">\n${entries
        .map(outline)
        .join("\n")}\n    </outline>`,
  )
  .join("\n")}
  </body>
</opml>
`;
}
