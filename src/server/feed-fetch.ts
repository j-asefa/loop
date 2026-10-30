import ipaddr from "ipaddr.js";
import { fetch as undiciFetch } from "undici";
import { parseFeed } from "./syndication.js";
import { Problem } from "./domain.js";
import { publicAddress, publicNetworkDispatcher } from "./mcp/network.js";
import type { FeedEntry, NewsStory } from "../shared/news.js";

// Reading one public feed over the network: the request Loop55 makes, which
// redirects it will follow, and how much of the body it will take. Kept apart
// from news.ts so the liveness script (scripts/feed-liveness.mjs) checks the
// catalog through the same code that serves it, without opening the database.

const TIMEOUT_MS = 10_000;
// A hard ceiling, not a budget: reading stops at MAX_STORIES items long before
// this for any feed that closes its tags. Full-text feeds are routinely over
// two megabytes, which is what the old cap silently excluded.
const MAX_BYTES = 8_000_000;
const MAX_REDIRECTS = 3;
const AGENT = "Loop55/1.0 (feed reader)";
// Items read from one feed. The parser keeps 50 and Social shows 20 of those,
// so a feed that lists hundreds is cut off rather than downloaded whole.
const MAX_ITEMS = 100;
/** The longest feed or page address Loop55 will take. */
export const MAX_URL = 2048;
/** A feed's picture, which Loop55 passes through rather than the browser. */
const MAX_IMAGE_BYTES = 5_000_000;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

type NewsFetch = (url: string, init: RequestInit) => Promise<Response>;
// Every feed is read through the dispatcher that resolves DNS itself and
// refuses any host answering on a private address. Catalog feeds are public
// too, so they lose nothing by it, and a feed someone added by URL cannot be
// used to reach something on this network.
const publicOnlyFetch: NewsFetch = (url, init) =>
  undiciFetch(url, {
    ...init,
    dispatcher: publicNetworkDispatcher,
  } as any) as unknown as Promise<Response>;
let newsFetch: NewsFetch = publicOnlyFetch;

/** Tests and the liveness script swap the network; returns a restore function. */
export function withFeedFetch(fetcher: NewsFetch) {
  const previous = newsFetch;
  newsFetch = fetcher;
  return () => {
    newsFetch = previous;
  };
}

/**
 * A feed address Loop55 will request: public HTTPS, nothing embedded that a
 * server could act on, and never an address inside this network. A hostname
 * that resolves to a private address is refused at connect time instead, by
 * the dispatcher, so this cannot be worked around with DNS.
 */
export function feedUrl(value: string) {
  const refuse = (why: string) => new Problem(400, why);
  if (value.length > MAX_URL) throw refuse("That address is too long.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw refuse("Enter a feed address starting with https://");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:")
    throw refuse("Feeds are read over HTTPS. Use an https:// address.");
  if (url.username || url.password)
    throw refuse("Loop55 can't read a feed that needs a username or password.");
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal") ||
    (ipaddr.isValid(host) && !publicAddress(host))
  )
    throw refuse("That address is on this network, so Loop55 won't read it.");
  url.hash = "";
  return url;
}

/** An error that carries how long the feed asked to be left alone. */
export const unavailable = (
  message: string,
  retryAfterMs: number | null = null,
) => Object.assign(new Problem(400, message), { retryAfterMs });

/** The seconds or HTTP-date in a Retry-After header, as milliseconds. */
export function retryAfterOf(response: Response) {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Where a redirect leads, if it stays on the feed's own site: the same host
 * or one under it (www. aside), the same port, and never from https to http.
 */
export function redirectTarget(
  feed: FeedEntry,
  from: string,
  location: string,
) {
  const origin = new URL(feed.url);
  const site = origin.hostname.replace(/^www\./, "");
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new Problem(400, `${feed.name} redirected to an invalid address`);
  }
  const sameSite =
    (next.hostname === site || next.hostname.endsWith(`.${site}`)) &&
    next.port === origin.port &&
    (next.protocol === "https:" ||
      (next.protocol === "http:" && origin.protocol === "http:"));
  if (!sameSite)
    throw new Problem(
      400,
      `${feed.name} redirected away from ${origin.hostname}`,
    );
  // Reddit answers its feeds with a redirect to /login?dest=<the feed>. That
  // is the same site, so the hop is allowed and the sign-in page then fails to
  // parse; say what is actually wrong instead.
  const asked = new URL(from).pathname;
  const back =
    next.searchParams.get("dest") || next.searchParams.get("return_to") || "";
  if (
    /^\/(login|signin|sign-in)(\/|$)/i.test(next.pathname) ||
    (asked.length > 1 && back.includes(asked))
  )
    throw new Problem(400, `${feed.name} needs an account to read`);
  return next.href;
}

/**
 * The body as text, stopping once the document holds the stories Loop55 is
 * going to use. An XML feed is read as a prefix: the scanner in
 * syndication.ts skips an opening tag with no closing tag, so cutting a
 * document after a closing </item> or </entry> parses to exactly the items
 * before the cut. A JSON Feed cannot be cut that way — a half document is not
 * valid JSON — so it is read whole, up to the ceiling.
 */
async function readCapped(
  response: Response,
  name: string,
  limits: { items?: number; bytes?: number } = {},
) {
  const wanted = limits.items ?? MAX_ITEMS;
  const ceiling = limits.bytes ?? MAX_BYTES;
  const tooLarge = () => new Problem(400, `${name} is too large`);
  if (
    !limits.bytes &&
    Number(response.headers.get("content-length")) > ceiling
  ) {
    response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // Decoded chunks are kept apart and joined once. Appending to one string
  // instead would copy the whole document on every chunk, which for a feed
  // that never closes an item means copying its way up to the ceiling.
  const chunks: string[] = [];
  let tail = "";
  let size = 0;
  let items = 0;
  let json: boolean | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ceiling) {
      reader.cancel().catch(() => {});
      // A page is read for its head, so what is past the ceiling is simply
      // not read; a feed that long is refused, as it was before.
      if (limits.bytes) {
        chunks.push(
          decoder.decode(
            value.subarray(0, Math.max(0, ceiling - (size - value.byteLength))),
            { stream: true },
          ),
        );
        break;
      }
      throw tooLarge();
    }
    // A chunk boundary can fall inside a character or inside a tag, so the
    // decoder streams and each chunk is scanned with the tail of the last.
    const added = decoder.decode(value, { stream: true });
    chunks.push(added);
    if (json === null) {
      const start = added.trimStart();
      if (start) json = start[0] === "{";
    }
    if (json) continue;
    // Chunks can be smaller than a closing tag, so what is carried forward is
    // the unmatched end of the last scan rather than the last chunk: with
    // one-byte chunks the tag would otherwise never be assembled, and a feed
    // that is perfectly readable would be read to the ceiling and refused.
    const scanned = tail + added;
    items += closings(scanned);
    tail = scanned.slice(
      Math.max(lastClosing(scanned), scanned.length - CLOSING_TAG),
    );
    if (items >= wanted) {
      reader.cancel().catch(() => {});
      // Cut after the last closing tag: what follows cannot be a whole item.
      const text = chunks.join("");
      const end = lastClosing(text);
      return end > 0 ? text.slice(0, end) : text;
    }
  }
  return chunks.join("") + decoder.decode();
}

// Long enough to hold a partial "</entry>" across scans.
const CLOSING_TAG = 10;
const CLOSES = /<\/(item|entry)\s*>/gi;
function closings(text: string) {
  CLOSES.lastIndex = 0;
  let found = 0;
  while (CLOSES.exec(text)) found++;
  return found;
}
function lastClosing(text: string) {
  CLOSES.lastIndex = 0;
  let end = 0;
  for (let match; (match = CLOSES.exec(text));) end = CLOSES.lastIndex;
  return end;
}

/**
 * A web page, for finding the feeds it advertises. Same transport and caps as
 * a feed; the markup is only ever scanned for <link> elements, never rendered.
 */
/**
 * An address a feed or a person supplied, with every destination checked
 * before it is requested. The dispatcher refuses a host that resolves to a
 * private address, but a literal IP never reaches a lookup — so a public page
 * must not be able to redirect Loop55 at something on this network.
 */
async function fetchValidated(
  url: string,
  accept: string,
  signal: AbortSignal,
) {
  let at = feedUrl(url).href;
  for (let hops = 0; ; hops++) {
    const response = await newsFetch(at, {
      headers: { accept, "user-agent": AGENT },
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location)
      return response;
    response.body?.cancel().catch(() => {});
    if (hops >= MAX_REDIRECTS)
      throw new Problem(400, "That address redirected too many times.");
    let next: URL;
    try {
      next = new URL(location, at);
    } catch {
      throw new Problem(400, "That address redirected somewhere invalid.");
    }
    at = feedUrl(next.href).href;
  }
}

/** The picture a feed offered for a story: bytes, and what kind they are. */
export async function imageBytes(url: string) {
  const response = await fetchValidated(
    url,
    "image/*",
    AbortSignal.timeout(TIMEOUT_MS),
  );
  const type = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  // Only real raster images, served as themselves. SVG is a document that can
  // carry script, so it is not served even from a feed that offered one.
  if (!response.ok || !IMAGE_TYPES.has(type)) {
    response.body?.cancel().catch(() => {});
    throw new Problem(404, "No picture there.");
  }
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    response.body?.cancel().catch(() => {});
    throw new Problem(413, "That picture is too large.");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Problem(413, "That picture is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { type, bytes };
}

export async function pageText(url: string) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetchValidated(url, "text/html,*/*;q=0.8", signal);
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw unavailable(
      `That address answered ${response.status}`,
      retryAfterOf(response),
    );
  }
  // A page is scanned for the <link> elements in its head, so half a megabyte
  // of it is plenty and the rest is never read.
  return readCapped(response, "That page", { items: Infinity, bytes: 512_000 });
}

/** What a feed answered: its stories, or that the copy on hand is still good. */
export type Downloaded =
  | { modified: false }
  | {
      modified: true;
      stories: NewsStory[];
      title: string | null;
      home: string | null;
      etag: string | null;
      last_modified: string | null;
    };

/**
 * Every story a feed is currently offering, newest first as it lists them.
 * Passing the validators from the last read lets a feed answer 304 and send
 * nothing, which most of them do.
 */
export async function download(
  feed: FeedEntry,
  validators: { etag?: string | null; last_modified?: string | null } = {},
): Promise<Downloaded> {
  const { name } = feed;
  // One deadline covers every redirect and the whole body.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = feed.url;
  for (let hops = 0; ; hops++) {
    const response = await newsFetch(url, {
      // Reddit refuses requests without a descriptive User-Agent.
      headers: {
        accept:
          "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.8",
        "user-agent": AGENT,
        ...(validators.etag && { "if-none-match": validators.etag }),
        ...(validators.last_modified && {
          "if-modified-since": validators.last_modified,
        }),
      },
      // Redirects are followed here, so each one is checked first.
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      response.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS)
        throw new Problem(400, `${name} redirected too many times`);
      url = redirectTarget(feed, url, location);
      continue;
    }
    // Nothing has changed since the last read: keep the stories on hand.
    if (response.status === 304) {
      response.body?.cancel().catch(() => {});
      return { modified: false };
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw unavailable(
        `${name} answered ${response.status}`,
        retryAfterOf(response),
      );
    }
    const feedUrl = url;
    const { stories, title, home } = parseFeed(
      await readCapped(response, `${name}'s feed`),
      feedUrl,
    );
    if (!stories.length) throw new Problem(400, `${name} feed had no stories`);
    return {
      modified: true,
      stories,
      title,
      home,
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
    };
  }
}
