import * as feedDigestsQueries from "./sql/feed-digests.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar } from "./registrar.js";

import { DigestInput as digestInput } from "../shared/social-contract-schemas.js";
import { db, id, now } from "./db.js";
import { Problem, ownedAgent, ownedConversation } from "./domain.js";
import { submit } from "./agent-runtime.js";
import { feedForAgent, ownerFeed, ownerFeeds } from "./news.js";

// A digest Loop sends on a schedule: once a day, at a clock time in the
// owner's own zone, into a thread they chose. Loop assembles the stories and
// asks the agent to summarize them — the agent is not left to go and find
// them, and nothing is marked read by a summary.

/** Stories one digest carries, and how much prompt they may fill. */
const PER_DIGEST = 60;
const MAX_CHARS = 8000;
const PER_OWNER = 10;

export type FeedDigest = {
  id: string;
  owner_id: string;
  agent_id: string;
  conversation_id: string | null;
  feeds: string | null;
  minute_of_day: number;
  zone: string;
  unread_only: number;
  enabled: number;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
};

/** A zone name Intl knows. Anything else would silently never come due. */
function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    throw new Problem(400, "Choose a time zone Loop recognizes.");
  }
}

function listDigests(owner: string) {
  return feedDigestsQueries.forOwner(db, owner);
}

export function saveDigest(owner: string, body: unknown, digestId?: string) {
  const d = digestInput.parse(body);
  validZone(d.zone);
  ownedAgent(d.agentId, owner);
  if (d.conversationId) ownedConversation(d.conversationId, owner);
  // Keep existing explicit scope when a feed has since been unfollowed.
  // The prompt already skips it; converting an empty selection to NULL would
  // accidentally widen the digest to every feed.
  const previous = digestId
    ? feedDigestsQueries.owned(db, digestId, owner)
    : undefined;
  if (digestId && !previous) throw new Problem(404, "No such digest.");
  const previousFeeds: string[] = previous?.feeds
    ? JSON.parse(previous.feeds)
    : [];
  for (const feed of d.feeds || [])
    if (!previousFeeds.includes(feed)) ownerFeed(owner, feed);
  const row = {
    id: digestId || id(),
    owner: owner,
    agent: d.agentId,
    conversation: d.conversationId ?? null,
    feeds: d.feeds?.length ? JSON.stringify(d.feeds) : null,
    minute: d.minuteOfDay,
    zone: d.zone,
    unread: d.unreadOnly ? 1 : 0,
    enabled: d.enabled ? 1 : 0,
    at: now(),
  };
  if (digestId) {
    const changed = feedDigestsQueries.update(db, row).changes;
    if (!changed) throw new Problem(404, "No such digest.");
  } else {
    if (listDigests(owner).length >= PER_OWNER)
      throw new Problem(400, `You can have ${PER_OWNER} digests.`);
    feedDigestsQueries.insert(db, row);
  }
  return feedDigestsQueries.owned(db, row.id, owner) as FeedDigest;
}

function removeDigest(owner: string, digestId: string) {
  const changed = feedDigestsQueries.remove(db, digestId, owner).changes;
  if (!changed) throw new Problem(404, "No such digest.");
}

/** The local date and minute-of-day in a zone, from Intl rather than offsets. */
export function localTime(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const of = (type: string) => parts.find((part) => part.type === type)!.value;
  return {
    day: `${of("year")}-${of("month")}-${of("day")}`,
    minute: Number(of("hour")) * 60 + Number(of("minute")),
  };
}

/**
 * A digest is due when its clock time has passed today, in its own zone, and
 * it has not already run today. Comparing local days rather than elapsed time
 * means a daylight-saving change keeps it at the same clock time, and a server
 * that was off for a day sends one digest when it comes back, not five.
 */
export function dueDigests(at: number) {
  return listEnabled().filter((digest) => {
    const here = localTime(at, digest.zone);
    if (here.minute < digest.minute_of_day) return false;
    return (
      !digest.last_run_at ||
      localTime(digest.last_run_at, digest.zone).day !== here.day
    );
  });
}

const listEnabled = () => feedDigestsQueries.enabled(db);

/** What Loop asks the agent, with the stories it is asking about. */
export function digestPrompt(digest: FeedDigest, at: number) {
  const feeds: string[] | null = digest.feeds ? JSON.parse(digest.feeds) : null;
  // A digest that has never run covers the last day rather than everything
  // ever stored.
  const since = digest.last_run_at ?? at - 24 * 60 * 60_000;
  const lines: string[] = [];
  let characters = 0;
  const followed = new Set(ownerFeeds(digest.owner_id).map((feed) => feed.id));
  for (const feed of feeds ?? [undefined]) {
    if (feed !== undefined && !followed.has(feed)) continue;
    const read = feedForAgent(digest.owner_id, {
      feedId: feed,
      unreadOnly: !!digest.unread_only,
      // What arrived since the last digest, not everything still unread: a
      // digest does not mark anything read, so without this boundary the same
      // headlines would be summarized again every day.
      arrivedSince: since,
      limit: 50,
    });
    for (const story of read.stories) {
      if (lines.length >= PER_DIGEST || characters >= MAX_CHARS) break;
      const line = `- ${story.title} · ${story.feed} · ${story.url}${
        story.summary ? `\n  ${story.summary}` : ""
      }`;
      characters += line.length;
      lines.push(line);
    }
  }
  if (!lines.length) return null;
  return (
    `Here is what arrived in the user's feeds since ${new Date(
      since,
    ).toISOString()}. Summarize the few things worth their attention, group ` +
    `related stories, say plainly if there is nothing notable, and link what ` +
    `you cite. Don't describe the list itself.\n\n${lines.join("\n")}`
  );
}

/**
 * Worker job: sends each due digest once. The key is the digest and its local
 * day, so a retry, a restart or a second worker cannot send it twice.
 */
export function runDueDigests(at = now()) {
  let sent = 0;
  for (const digest of dueDigests(at)) {
    const day = localTime(at, digest.zone).day;
    try {
      const input = digestPrompt(digest, at);
      // Nothing new is not worth a thread; try again tomorrow.
      if (input)
        submit(digest.owner_id, {
          agentId: digest.agent_id,
          conversationId: digest.conversation_id ?? undefined,
          input,
          idempotencyKey: `feed-digest:${digest.id}:${day}`,
          steer: false,
          automation: { kind: "feed_digest", digestId: digest.id },
        });
      feedDigestsQueries.delivered(db, at, digest.id);
      if (input) sent++;
    } catch (error) {
      // A thread or agent that is gone ends the digest; anything else is
      // worth reporting and trying again tomorrow.
      const gone = error instanceof Problem && error.status === 404;
      feedDigestsQueries.failed(
        db,
        at,
        String((error as Error).message).slice(0, 300),
        gone ? 0 : digest.enabled,
        digest.id,
      );
    }
  }
  return sent;
}

const routes = registrar("feedDigests");
export const feedDigests = routes.mount;
routes.on(workspaceApi.socialDigests, (_req, res) => {
  res.json({ digests: listDigests(res.locals.owner) });
});
routes.on(workspaceApi.socialDigestCreate, (req, res) => {
  res.status(201).json(saveDigest(res.locals.owner, req.body));
});
routes.on(workspaceApi.socialDigestUpdate, (req, res) => {
  res.json(saveDigest(res.locals.owner, req.body, req.params.id));
});
routes.on(workspaceApi.socialDigestDelete, (req, res) => {
  removeDigest(res.locals.owner, req.params.id);
  res.json({ digests: listDigests(res.locals.owner) });
});
