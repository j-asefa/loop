import type { ApiFeedItem } from "./api/types";

export type FeedTab = "done" | "working" | "queued" | "replies";

export type NativeResultCard = {
  id: string;
  conversationId: string;
  tab: FeedTab;
  agentId?: string | null;
  agentName: string;
  projectName: string;
  model: string;
  prompt: string;
  fallbackTitle: string;
  body: string;
  bodyTruncated?: boolean;
  createdAt: number;
  saved: boolean;
  unread: boolean;
  doneUnread?: boolean;
  replyUnread?: boolean;
  statusLabel?: string;
  /** Live companion identifiers for mutations (read, dismiss, save, reply). */
  messageId?: string;
  doneCardKey?: string;
  replyCardKey?: string;
  unreadVersion?: number;
  runId?: string;
  runState?: string;
  runError?: string | null;
};

export function feedItemToNativeCard(
  item: ApiFeedItem,
  tab: FeedTab,
): NativeResultCard {
  const msg = item.last_message;
  const doneBody =
    item.card?.display?.last_message?.content ??
    item.card?.display?.last_message?.preview ??
    item.live_preview ??
    msg?.content ??
    msg?.preview ??
    "";
  const prompt =
    item.reply?.content ?? item.run?.input ?? item.title ?? "Result";
  const id =
    item.done_card_key ??
    item.reply_card_key ??
    msg?.id ??
    `${item.conversation_id}:${item.last_activity_at}`;

  const statusLabel =
    tab === "working"
      ? "Working"
      : tab === "queued"
        ? "Queued"
        : item.reply && item.reply.read_at === null
          ? "Reply"
          : undefined;

  return {
    id,
    conversationId: item.conversation_id,
    tab,
    agentId: item.agent_id,
    agentName: item.agent_name || "agent",
    projectName: item.project_name || "Workspace",
    model: item.run?.resolved_model || item.run?.model || "",
    prompt,
    fallbackTitle: item.title || "Result",
    body: doneBody,
    bodyTruncated: Boolean(
      msg?.content_truncated ||
      (tab === "replies" && doneBody.length >= 980) ||
      (!msg?.content && Boolean(msg?.preview) && doneBody.length >= 980),
    ),
    createdAt: msg?.created_at ?? item.last_activity_at,
    saved: Boolean(msg?.saved),
    unread:
      tab === "done"
        ? item.read_at === null
        : tab === "replies"
          ? item.reply?.read_at === null
          : false,
    doneUnread: tab === "done" ? item.read_at === null : false,
    replyUnread: tab === "replies" ? item.reply?.read_at === null : false,
    statusLabel,
    messageId: msg?.id ?? item.reply?.message_id,
    doneCardKey: item.done_card_key,
    replyCardKey: item.reply_card_key,
    unreadVersion: item.unread_version,
    runId: item.run?.id,
    runState: item.run?.state,
    runError: item.run?.error,
  };
}

/**
 * Merges canonical Done cards and Reply cards into one newest-first feed deck,
 * preserving unread state and both card keys when a message appears in both.
 */
export function mergeUnifiedFeedCards(
  doneItems: ApiFeedItem[],
  replyItems: ApiFeedItem[],
): NativeResultCard[] {
  const unified = doneItems.map((item) => feedItemToNativeCard(item, "done"));
  const byMessageId = new Map<string, number>();
  unified.forEach((c, idx) => {
    if (c.messageId) byMessageId.set(c.messageId, idx);
  });

  for (const replyItem of replyItems) {
    const replyCard = feedItemToNativeCard(replyItem, "replies");
    const asFeedCard: NativeResultCard = {
      ...replyCard,
      tab: "done",
    };
    const existingIdx =
      asFeedCard.messageId !== undefined
        ? byMessageId.get(asFeedCard.messageId)
        : undefined;
    if (existingIdx !== undefined) {
      const existing = unified[existingIdx];
      unified[existingIdx] = {
        ...existing,
        unread: existing.unread || asFeedCard.unread,
        doneUnread: Boolean(existing.doneUnread),
        replyUnread: Boolean(asFeedCard.replyUnread),
        replyCardKey: asFeedCard.replyCardKey ?? existing.replyCardKey,
        statusLabel: asFeedCard.statusLabel ?? existing.statusLabel,
        createdAt: Math.max(existing.createdAt, asFeedCard.createdAt),
      };
    } else {
      if (asFeedCard.messageId) {
        byMessageId.set(asFeedCard.messageId, unified.length);
      }
      unified.push(asFeedCard);
    }
  }

  unified.sort((a, b) => b.createdAt - a.createdAt);
  return unified;
}

/**
 * Returns every server-side dismiss/archive target that belongs to a card
 * (both halves when a Done card and Reply card were merged into one entry).
 */
export function getCardDismissTargets(card: NativeResultCard): {
  doneKey?: string;
  replyMessageId?: string;
} {
  return {
    ...(card.doneCardKey ? { doneKey: card.doneCardKey } : {}),
    ...(card.replyCardKey && card.messageId
      ? { replyMessageId: card.messageId }
      : {}),
  };
}

/**
 * Merges live conversation cards with optional seed/override cards (such as a
 * synthetic `working:*` card or a card opened from Agent Profile) so live cards
 * always supersede stale overrides and newer arrivals surface at index 0.
 */
export function mergeCarouselCards(
  liveCards: NativeResultCard[],
  overrideCards: NativeResultCard[] | null | undefined,
): NativeResultCard[] {
  const overrides = overrideCards ?? [];
  if (overrides.length === 0) return liveCards;

  const liveIds = new Set(liveCards.map((c) => c.id));
  const liveMsgs = new Set(
    liveCards.map((c) => c.messageId).filter((m): m is string => Boolean(m)),
  );
  const liveFinishedRuns = new Set(
    liveCards
      .filter((c) => c.tab !== "working" && c.runId)
      .map((c) => c.runId!),
  );
  const newestLiveFinishedAt = liveCards.reduce(
    (max, c) => (c.tab !== "working" ? Math.max(max, c.createdAt) : max),
    -1,
  );

  const keptOverrides: NativeResultCard[] = [];
  for (const ov of overrides) {
    if (liveIds.has(ov.id)) continue;
    if (ov.messageId && liveMsgs.has(ov.messageId)) continue;
    if (ov.tab === "working") {
      if (ov.runId && liveFinishedRuns.has(ov.runId)) continue;
      if (newestLiveFinishedAt >= ov.createdAt) continue;
    }
    keptOverrides.push(ov);
  }

  if (keptOverrides.length === 0) return liveCards;

  return [...liveCards, ...keptOverrides].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    const aLive = liveIds.has(a.id) ? 1 : 0;
    const bLive = liveIds.has(b.id) ? 1 : 0;
    return bLive - aLive;
  });
}

export function carouselCardKey(card: NativeResultCard): string {
  return card.messageId || card.id;
}

export function resolveCarouselSelection(
  cards: NativeResultCard[],
  selection: { index: number; key?: string },
): number {
  const current = cards[selection.index];
  if (current && carouselCardKey(current) === selection.key)
    return selection.index;
  const matching = cards.findIndex(
    (card) => carouselCardKey(card) === selection.key,
  );
  return matching >= 0
    ? matching
    : Math.max(0, Math.min(selection.index, cards.length - 1));
}

export type CarouselSaveEdit = {
  saved: boolean;
  revision: number;
  pending?: boolean;
  uncertain?: boolean;
};

export function reconcileCarouselSaves(
  edits: Map<string, CarouselSaveEdit>,
  savedIds: string[],
  requestRevision: number,
): Map<string, CarouselSaveEdit> {
  const saved = new Set(savedIds);
  let next = edits;
  for (const [key, edit] of edits) {
    if (!edit.uncertain || edit.revision > requestRevision) continue;
    if (next === edits) next = new Map(edits);
    next.set(key, { revision: edit.revision, saved: saved.has(key) });
  }
  return next;
}

export function openingCarouselCardIds(
  cards: NativeResultCard[],
  recentCards: NativeResultCard[],
  openingCard?: NativeResultCard,
  prioritizeOpening = true,
): string[] {
  const selected =
    openingCard &&
    (cards.find((card) => card.id === openingCard.id) ??
      cards.find(
        (card) =>
          openingCard.messageId && card.messageId === openingCard.messageId,
      ));
  const ids = recentCards.map((card) => card.id);
  if (!selected) return ids;
  if (prioritizeOpening) {
    return [selected.id, ...ids.filter((id) => id !== selected.id)].slice(
      0,
      ids.length,
    );
  }
  return ids.includes(selected.id) ? ids : [...ids.slice(0, -1), selected.id];
}

export type CarouselHistoryPage = {
  cards: NativeResultCard[];
  next: string | null;
};

export function mergeCarouselHistoryPage(
  current: CarouselHistoryPage,
  incoming: CarouselHistoryPage,
  mode: "replace" | "refresh" | { before: string },
): CarouselHistoryPage {
  if (mode === "replace") return incoming;
  if (typeof mode === "object" && mode.before !== current.next) return current;
  const [first, rest] =
    mode === "refresh"
      ? [incoming.cards, current.cards]
      : [current.cards, incoming.cards];
  const seen = new Set(first.map(carouselCardKey));
  const distinct = rest.filter((card) => !seen.has(carouselCardKey(card)));
  // With no overlap there is no proof that the old cursor covers the
  // gap. Restart from the incoming cursor so every intervening card is reachable.
  if (mode === "refresh" && distinct.length === rest.length) return incoming;
  return {
    cards: [...first, ...distinct],
    next: mode === "refresh" ? current.next : incoming.next,
  };
}

/**
 * Strips fenced code/spec blocks (including long or unclosed fences) in O(n)
 * before formatting a compact single-line preview for Feed cards.
 */
export function feedPreviewText(markdown: string, maxChars = 700): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let collected = 0;
  let activeFence: string | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (activeFence) {
      if (trimmed.startsWith(activeFence)) {
        activeFence = null;
      }
      continue;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed[0];
      let len = 3;
      while (trimmed[len] === marker) len++;
      activeFence = marker.repeat(len);
      continue;
    }
    kept.push(line);
    collected += line.length + 1;
    if (collected >= maxChars) break;
  }

  return kept
    .join("\n")
    .slice(0, maxChars)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/\|/g, " · ")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "• ")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\s+/g, " ")
    .trim();
}

export type QuickReplyOption = {
  id: string;
  label: string;
  hint: string;
  instruction: string;
};

export const QUICK_REPLIES: QuickReplyOption[] = [
  {
    id: "deeper",
    label: "Go deeper",
    hint: "Ask for concrete tradeoffs and edge cases",
    instruction:
      "Go one level deeper on the main tradeoffs, failure modes, and what you would change first.",
  },
  {
    id: "checklist",
    label: "Turn into checklist",
    hint: "Distill into an actionable step-by-step plan",
    instruction:
      "Turn this recommendation into a crisp 5-step execution checklist we can run this week.",
  },
  {
    id: "counter",
    label: "Steelman the opposite",
    hint: "Challenge the current recommendation",
    instruction:
      "Make the strongest argument against this recommendation and tell me what assumption would flip your answer.",
  },
  {
    id: "summary",
    label: "3-bullet summary",
    hint: "Tighten for quick sharing",
    instruction:
      "Compress the key takeaway into 3 sharp bullets I can share with the team.",
  },
];

const HOUR = 3_600_000;
const MINUTE = 60_000;

export function createInitialCards(now = Date.now()): NativeResultCard[] {
  return [
    {
      id: "willow-4",
      conversationId: "conv-willow",
      tab: "done",
      agentId: "agent-willow",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt: "Explore posts and comments for the feed",
      fallbackTitle: "Explore posts and comments for the feed",
      body:
        "## A quieter feed with stacked result cards\n\n" +
        "A session can be one stack, with each discrete answer tucked neatly behind the newest card. Keep decisions visible and let readers swipe straight to any earlier result.\n\n" +
        "- **Stack on Done:** Newest card sits on top with earlier cards peeking cleanly beneath it\n" +
        "- **120fps native carousel:** Flip left/right across every discrete result with haptic detents\n" +
        "- **Direct thread search:** Tap the search icon above and try **Hetzner**, **residency**, or **latency**\n\n" +
        "Tap **Pair** in the header to connect your live Loop workspace with `loop pair`.",
      createdAt: now - 5 * MINUTE,
      saved: false,
      unread: true,
      messageId: "willow-4",
    },
    {
      id: "willow-3",
      conversationId: "conv-willow",
      tab: "done",
      agentId: "agent-willow",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt:
        "Audit mobile feed latency and card ergonomics on a 390px phone screen.\n" +
        "Focus on keeping tool traces out of feed cards, making multi-turn results easy to browse without chat scrolling, and avoiding clipped titles or keyboard zoom bugs.",
      fallbackTitle: "Mobile reading ergonomics",
      body:
        "### Mobile reading ergonomics\n\n" +
        "Two changes made the biggest difference on a 390px viewport:\n\n" +
        "1. **Messages only in cards:** Keeping tool traces and exit codes out of feed cards cuts visual clutter by half — you read what the agent concluded, not terminal exhaust.\n" +
        "2. **Stacked discrete cards → native floating carousel:** Grouping multi-turn results from the same thread into a single stack keeps Done calm, while swiping left/right preserves every answer as its own saveable, searchable card.",
      createdAt: now - 1 * HOUR,
      saved: false,
      unread: true,
      messageId: "willow-3",
    },
    {
      id: "willow-2",
      conversationId: "conv-willow",
      tab: "done",
      agentId: "agent-willow",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt:
        "Can you break down EU data residency guarantees, Frankfurt vs Falkenstein latency, monthly egress pricing at 2 TB/month, and how Hetzner + Bunny CDN compares against Fly.io and Render for a small team?",
      fallbackTitle: "EU data residency and Bunny CDN monthly costs",
      body:
        "EU data residency stays cleanly in Frankfurt/Falkenstein with **Hetzner + Bunny CDN** (~€38/month total at 2 TB egress), versus ~€61/month on Fly.io.\n\n" +
        "```spec\n" +
        '{"op":"add","path":"/root","value":"card"}\n' +
        '{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Monthly EU cost breakdown"},"children":["tbl","acts"]}}\n' +
        '{"op":"add","path":"/elements/tbl","value":{"type":"Table","props":{"columns":["Provider","Compute","CDN / Egress","Total / mo"],"rows":[["Hetzner + Bunny CDN","€24","€14","€38"],["Render EU","€42","€12","€54"],["Fly.io (fra + ams)","€49","€12","€61"]]}}}\n' +
        '{"op":"add","path":"/elements/acts","value":{"type":"Actions","children":["b1","b2"]}}\n' +
        '{"op":"add","path":"/elements/b1","value":{"type":"ReplyButton","props":{"label":"Go with Hetzner + Bunny","prompt":"Lock in Hetzner + Bunny CDN and draft the deployment checklist"}}}\n' +
        '{"op":"add","path":"/elements/b2","value":{"type":"ReplyButton","props":{"label":"Check failover plan","prompt":"What happens if Falkenstein goes down? Give me a simple failover plan"}}}\n' +
        "```",
      createdAt: now - 2 * HOUR,
      saved: true,
      unread: false,
      messageId: "willow-2",
    },
    {
      id: "willow-1",
      conversationId: "conv-willow",
      tab: "done",
      agentId: "agent-willow",
      agentName: "willow",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt:
        "Compare the best hosting options for our next product experiment",
      fallbackTitle: "Hosting comparison",
      body:
        "### Hosting comparison\n\n" +
        "Three practical options for the first 10k users:\n\n" +
        "- **Hetzner Cloud (Falkenstein / Helsinki):** ~€24/mo for 4 vCPU + 8 GB RAM, predictable egress, EU data stays in-region.\n" +
        "- **Fly.io (fra + iad):** ~€61/mo for two regions with fast cold deploys and built-in Anycast routing.\n" +
        "- **Render:** ~€48/mo managed setup, slowest EU cold-start among the three.\n\n" +
        "**Initial recommendation:** Start with Hetzner + a lightweight CDN unless multi-region writes are required on day one.",
      createdAt: now - 3 * HOUR,
      saved: false,
      unread: false,
      messageId: "willow-1",
    },
    {
      id: "cedar-1",
      conversationId: "conv-cedar",
      tab: "done",
      agentId: "agent-cedar",
      agentName: "cedar",
      projectName: "Loop Core",
      model: "gpt-5.4",
      prompt: "Review PR #449 before merge",
      fallbackTitle: "Review PR #449 before merge",
      body:
        "No P1 or security findings in PR #449.\n\n" +
        "- Checked owner isolation and draft preservation across reloads\n" +
        "- Verified `done-stack.ts` stays pure with zero server imports\n" +
        "- Safe to merge once CI finishes green.",
      createdAt: now - 42 * MINUTE,
      saved: false,
      unread: true,
      messageId: "cedar-1",
    },
    {
      id: "iris-1",
      conversationId: "conv-iris",
      tab: "working",
      agentId: "agent-iris",
      agentName: "iris",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt: "Benchmark spring physics and haptic cadence on iPhone 16 Pro",
      fallbackTitle: "Benchmark spring physics and haptic cadence",
      body: "Measuring frame stability at 120Hz while interpolating peeking card scale and backdrop blur intensity. Initial results show zero dropped frames on the native UI thread.",
      createdAt: now - 2 * MINUTE,
      saved: false,
      unread: false,
      statusLabel: "Working",
      messageId: "iris-1",
    },
    {
      id: "maple-1",
      conversationId: "conv-maple",
      tab: "queued",
      agentId: "agent-maple",
      agentName: "maple",
      projectName: "Loop Core",
      model: "gpt-5.4",
      prompt: "Draft native iOS device pairing handshake for companion server",
      fallbackTitle: "Draft native iOS device pairing handshake",
      body: "Queued behind the current mobile gesture spike. Will design a scoped Keychain-backed device credential flow that preserves Loop's single-use QR pairing.",
      createdAt: now - 14 * MINUTE,
      saved: false,
      unread: false,
      statusLabel: "Queued",
      messageId: "maple-1",
    },
    {
      id: "fern-1",
      conversationId: "conv-fern",
      tab: "replies",
      agentId: "agent-fern",
      agentName: "fern",
      projectName: "Loop Mobile",
      model: "claude-sonnet-4",
      prompt: "Should swipe-right on a Feed card toggle Save or open Remind?",
      fallbackTitle: "Feed card swipe-right action",
      body:
        "I mocked both options for single-handed thumb use:\n\n" +
        "- **Swipe left → Mark Done / Read** (highest-frequency triage action)\n" +
        "- **Swipe right → Toggle Save** (instant bookmark without opening a second sheet)\n\n" +
        "Want to keep Save on swipe-right, or swap it to Remind?",
      createdAt: now - 18 * MINUTE,
      saved: false,
      unread: true,
      statusLabel: "Needs reply",
      messageId: "fern-1",
    },
  ];
}

export function buildSimulatedReply(
  conversationId: string,
  agentName: string,
  projectName: string,
  model: string,
  prompt: string,
): NativeResultCard {
  const lower = prompt.toLowerCase();
  let body: string;

  if (lower.includes("failover") || lower.includes("falkenstein")) {
    body =
      "### Falkenstein failover plan\n\n" +
      "Keep recovery under 5 minutes without active-active complexity:\n\n" +
      "1. **Litestream / hourly SQLite snapshots** shipped to a second EU region (Helsinki).\n" +
      "2. **Warm standby VM** (~€7/mo) ready to hydrate and cut DNS via Bunny / Cloudflare.\n" +
      "3. **Health probe alert** pushed directly to Loop on your phone before users notice.";
  } else if (lower.includes("checklist") || lower.includes("hetzner")) {
    body =
      "### Hetzner + Bunny CDN launch checklist\n\n" +
      "- Provision 4 vCPU / 8 GB node in **Falkenstein (fsn1)** with automatic firewall rules\n" +
      "- Point static & published artifacts through **Bunny CDN EU zone** (2 TB ≈ €14/mo)\n" +
      "- Enable encrypted off-box SQLite backups every 6 hours\n" +
      "- Smoke-test cold restart and verify p95 latency stays under 45ms in Europe";
  } else {
    body =
      "### Follow-up ready\n\n" +
      `Captured your follow-up cleanly as a new discrete card in **@${agentName}**'s stack.\n\n` +
      "- **Zero chat scroll:** Earlier results remain tucked to the right in this carousel\n" +
      "- **Searchable immediately:** Tap search above to jump across every card in the thread\n" +
      "- **Native haptics:** Swipe left/right to feel the detent lock between cards";
  }

  const id = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    conversationId,
    tab: "done",
    agentName,
    projectName,
    model,
    prompt,
    fallbackTitle: prompt,
    body,
    createdAt: Date.now(),
    saved: false,
    unread: true,
    messageId: id,
  };
}

export function relativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
