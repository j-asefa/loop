import type { ApiApproval, ApiNativeDecision } from "./api/types";
import type { NativeResultCard } from "./fixtures";

export type NotificationPrefs = {
  enabled: boolean;
  needsYou: boolean;
  completed: boolean;
  replies: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  needsYou: true,
  completed: true,
  replies: true,
};

export const MAX_NOTIFICATION_BURST = 5;

export type NotificationEventKind =
  "approval" | "decision" | "completed" | "reply";

export type NotificationEvent = {
  id: string;
  kind: NotificationEventKind;
  title: string;
  body: string;
  conversationId: string;
  agentName: string;
};

export type NotificationSnapshot = {
  approvalIds: Set<string>;
  decisionIds: Set<string>;
  doneUnreadIds: Set<string>;
  replyUnreadIds: Set<string>;
};

export type NotificationTapTarget = {
  conversationId: string;
  title: string;
  agentName: string;
};

function sanitizeNotificationLine(
  raw: string | null | undefined,
  maxLen: number,
): string {
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

export function parseNotificationPrefs(raw: string): NotificationPrefs {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_NOTIFICATION_PREFS };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      enabled:
        typeof obj.enabled === "boolean"
          ? obj.enabled
          : DEFAULT_NOTIFICATION_PREFS.enabled,
      needsYou:
        typeof obj.needsYou === "boolean"
          ? obj.needsYou
          : DEFAULT_NOTIFICATION_PREFS.needsYou,
      completed:
        typeof obj.completed === "boolean"
          ? obj.completed
          : DEFAULT_NOTIFICATION_PREFS.completed,
      replies:
        typeof obj.replies === "boolean"
          ? obj.replies
          : DEFAULT_NOTIFICATION_PREFS.replies,
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function serializeNotificationPrefs(prefs: NotificationPrefs): string {
  return JSON.stringify({
    enabled: Boolean(prefs.enabled),
    needsYou: Boolean(prefs.needsYou),
    completed: Boolean(prefs.completed),
    replies: Boolean(prefs.replies),
  });
}

function cardNotificationKey(card: NativeResultCard): string {
  return card.messageId || card.doneCardKey || card.replyCardKey || card.id;
}

export function buildNotificationSnapshot(
  input: {
    approvals: ApiApproval[] | null;
    decisions: ApiNativeDecision[] | null;
    cards: NativeResultCard[];
    repliesLoaded?: boolean;
  },
  previous?: NotificationSnapshot | null,
): NotificationSnapshot {
  const approvalIds =
    input.approvals === null
      ? new Set(previous?.approvalIds ?? [])
      : new Set<string>();
  if (input.approvals !== null) {
    for (const a of input.approvals) {
      if (a.state === "pending" && a.id) approvalIds.add(a.id);
    }
  }

  const decisionIds =
    input.decisions === null
      ? new Set(previous?.decisionIds ?? [])
      : new Set<string>();
  if (input.decisions !== null) {
    for (const d of input.decisions) {
      if (d.state === "pending" && d.id) decisionIds.add(d.id);
    }
  }

  const doneUnreadIds = new Set<string>();
  const repliesLoaded = input.repliesLoaded !== false;
  const replyUnreadIds = repliesLoaded
    ? new Set<string>()
    : new Set(previous?.replyUnreadIds ?? []);
  for (const c of input.cards) {
    const key = cardNotificationKey(c);
    if (!key) continue;
    if (repliesLoaded && c.replyUnread) {
      replyUnreadIds.add(key);
    }
    if (c.doneUnread || (c.unread && !c.replyUnread)) {
      doneUnreadIds.add(key);
    }
  }

  return { approvalIds, decisionIds, doneUnreadIds, replyUnreadIds };
}

/**
 * Compares the latest live workspace state against the previous live snapshot
 * and emits local notification events for newly arrived items only.
 *
 * When `previous` is `null` (cold start, cache hydration, or workspace switch),
 * no notifications are emitted so initial loads never spam the user.
 * When a sub-fetch (`approvals`, `decisions`, or `replies`) transiently fails
 * (`null` / `repliesLoaded: false`), its previous ID set is preserved so the
 * next successful refresh does not re-alert on already-seen items.
 */
export function detectNotificationEvents(
  previous: NotificationSnapshot | null,
  current: {
    approvals: ApiApproval[] | null;
    decisions: ApiNativeDecision[] | null;
    cards: NativeResultCard[];
    repliesLoaded?: boolean;
  },
  prefs: NotificationPrefs,
): { nextSnapshot: NotificationSnapshot; events: NotificationEvent[] } {
  const nextSnapshot = buildNotificationSnapshot(current, previous);
  if (!previous || !prefs.enabled) {
    return { nextSnapshot, events: [] };
  }

  const events: NotificationEvent[] = [];
  const pushEvent = (event: NotificationEvent) => {
    if (events.length >= MAX_NOTIFICATION_BURST) return;
    events.push(event);
  };

  if (prefs.needsYou) {
    if (current.approvals !== null) {
      for (const a of current.approvals) {
        if (a.state !== "pending" || !a.id || previous.approvalIds.has(a.id)) {
          continue;
        }
        const agent = sanitizeNotificationLine(a.agent_name || "agent", 32);
        const tool = sanitizeNotificationLine(a.tool_name || "tool action", 48);
        const detail = sanitizeNotificationLine(
          a.summary || `Approve ${tool}`,
          120,
        );
        pushEvent({
          id: `approval:${a.id}`,
          kind: "approval",
          title: `Approval needed · @${agent}`,
          body: detail || `Approve ${tool}`,
          conversationId: a.conversation_id,
          agentName: agent,
        });
      }
    }

    if (current.decisions !== null) {
      for (const d of current.decisions) {
        if (d.state !== "pending" || !d.id || previous.decisionIds.has(d.id)) {
          continue;
        }
        const titleText = sanitizeNotificationLine(
          d.title || "Decision needed",
          64,
        );
        const bodyText = sanitizeNotificationLine(
          d.question || d.prompt || "An agent is waiting for your input.",
          120,
        );
        pushEvent({
          id: `decision:${d.id}`,
          kind: "decision",
          title: titleText || "Decision needed",
          body: bodyText || "An agent is waiting for your input.",
          conversationId: d.conversation_id,
          agentName: "agent",
        });
      }
    }
  }

  const repliesLoaded = current.repliesLoaded !== false;
  if (prefs.replies && repliesLoaded) {
    for (const c of current.cards) {
      if (!c.replyUnread) continue;
      const key = cardNotificationKey(c);
      if (!key || previous.replyUnreadIds.has(key)) continue;
      const agent = sanitizeNotificationLine(c.agentName || "agent", 32);
      const snippet = sanitizeNotificationLine(
        c.body || c.fallbackTitle || "New reply",
        120,
      );
      pushEvent({
        id: `reply:${key}`,
        kind: "reply",
        title: `Reply from @${agent}`,
        body: snippet || "New reply",
        conversationId: c.conversationId,
        agentName: agent,
      });
    }
  }

  if (prefs.completed) {
    for (const c of current.cards) {
      const isDoneUnread = Boolean(
        c.doneUnread || (c.unread && !c.replyUnread),
      );
      if (!isDoneUnread) continue;
      const key = cardNotificationKey(c);
      if (!key || previous.doneUnreadIds.has(key)) continue;
      // Avoid double-notifying if the same card also fired as a reply above
      if (
        prefs.replies &&
        repliesLoaded &&
        c.replyUnread &&
        !previous.replyUnreadIds.has(key)
      ) {
        continue;
      }
      const agent = sanitizeNotificationLine(c.agentName || "agent", 32);
      const snippet = sanitizeNotificationLine(
        c.fallbackTitle || c.body || "Result ready",
        120,
      );
      pushEvent({
        id: `completed:${key}`,
        kind: "completed",
        title: `@${agent} finished`,
        body: snippet || "Result ready",
        conversationId: c.conversationId,
        agentName: agent,
      });
    }
  }

  return { nextSnapshot, events };
}

/**
 * Validates notification tap payload and enforces workspace isolation so a
 * notification from workspace A never opens a conversation inside workspace B.
 */
export function parseNotificationTapTarget(
  data: unknown,
  expectedOriginBucket: string,
): NotificationTapTarget | null {
  if (!expectedOriginBucket || !data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (
    typeof obj.originBucket !== "string" ||
    obj.originBucket !== expectedOriginBucket
  ) {
    return null;
  }
  if (typeof obj.conversationId !== "string") return null;
  const conversationId = obj.conversationId.trim();
  if (!conversationId || conversationId.length > 160) return null;
  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? sanitizeNotificationLine(obj.title, 80)
      : "Conversation";
  const agentName =
    typeof obj.agentName === "string" && obj.agentName.trim()
      ? sanitizeNotificationLine(obj.agentName, 40)
      : "agent";
  return { conversationId, title, agentName };
}
