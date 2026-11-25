import { describe, expect, it } from "vitest";
import { shouldRefreshForFrame } from "../apps/mobile/src/api/socket.js";
import {
  assertSameOriginResponse,
  extractSessionCookie,
  normalizeWorkspaceUrl,
  tryParsePairingLink,
} from "../apps/mobile/src/api/pairing-url.js";
import {
  feedItemToNativeCard,
  getCardDismissTargets,
  mergeUnifiedFeedCards,
} from "../apps/mobile/src/fixtures.js";
import type { ApiFeedItem } from "../apps/mobile/src/api/types.js";

function makeFeedItem(overrides: Partial<ApiFeedItem> = {}): ApiFeedItem {
  return {
    conversation_id: "conv-1",
    title: "Test thread",
    agent_id: "agent-1",
    agent_name: "ebony",
    project_name: "Loop",
    done_card_key: "done:m1",
    read_at: null,
    unread_version: 1,
    last_activity_at: 1000,
    last_message: {
      id: "m1",
      role: "assistant",
      content: "Completed task",
      created_at: 1000,
      saved: false,
    },
    run: {
      id: "run-1",
      state: "completed",
      input: "Do the thing",
    },
    pending_approvals: 0,
    ...overrides,
  };
}

describe("mobile socket frame filtering", () => {
  it("refreshes on v3 workspace events frames with nested event.type", () => {
    const frame = JSON.stringify({
      v: 3,
      type: "events",
      events: [{ id: 42, event: { type: "run_completed", runId: "r1" } }],
    });
    expect(shouldRefreshForFrame(frame)).toBe(true);
  });

  it("ignores v3 events frames containing only noisy streaming events (activity.updated, trace.updated, message.delta)", () => {
    const frame = JSON.stringify({
      v: 3,
      type: "events",
      events: [
        { id: 42, event: { type: "activity.updated" } },
        { id: 43, event: { type: "trace.updated" } },
        { id: 44, event: { type: "message.delta" } },
        { id: 45, event: { type: "native.usage" } },
      ],
    });
    expect(shouldRefreshForFrame(frame)).toBe(false);
    expect(
      shouldRefreshForFrame(
        JSON.stringify({ v: 3, type: "events", events: [] }),
      ),
    ).toBe(false);
  });

  it("refreshes on production v3 state-change events (completed, feed.card, message.completed, reset)", () => {
    const mixed = JSON.stringify({
      v: 3,
      type: "events",
      events: [
        { id: 1, event: { type: "activity.updated" } },
        { id: 2, event: { type: "feed.card" } },
      ],
    });
    expect(shouldRefreshForFrame(mixed)).toBe(true);
    expect(
      shouldRefreshForFrame(
        JSON.stringify({
          v: 3,
          type: "events",
          events: [{ id: 3, event: { type: "completed" } }],
        }),
      ),
    ).toBe(true);
    expect(shouldRefreshForFrame(JSON.stringify({ v: 3, type: "reset" }))).toBe(
      true,
    );
    expect(shouldRefreshForFrame(JSON.stringify({ type: "ping" }))).toBe(false);
  });
});

describe("mobile pairing URL security", () => {
  const validSecret = "a".repeat(40);

  it("accepts fragment-only #pair= links and rejects ?pair= query strings", () => {
    const parsed = tryParsePairingLink(
      `https://example.trycloudflare.com/#pair=${validSecret}`,
    );
    expect(parsed.origin).toBe("https://example.trycloudflare.com");
    expect(parsed.pairing?.secret).toBe(validSecret);

    expect(() =>
      tryParsePairingLink(
        `https://example.trycloudflare.com/?pair=${validSecret}`,
      ),
    ).toThrow(/fragment/i);
  });

  it("requires https:// for public hosts while allowing http:// for localhost, LAN, Tailscale, and single-label hosts", () => {
    expect(() => normalizeWorkspaceUrl("http://example.com")).toThrow(
      /https:\/\//i,
    );
    expect(normalizeWorkspaceUrl("http://localhost:3131").origin).toBe(
      "http://localhost:3131",
    );
    expect(normalizeWorkspaceUrl("http://192.168.1.42:3131").origin).toBe(
      "http://192.168.1.42:3131",
    );
    expect(normalizeWorkspaceUrl("http://100.64.12.9:3131").origin).toBe(
      "http://100.64.12.9:3131",
    );
    expect(normalizeWorkspaceUrl("http://mybox:3131").origin).toBe(
      "http://mybox:3131",
    );
  });

  it("rejects cleartext http:// for public IPv6 literals while allowing ::1 and IPv6 ULA", () => {
    expect(() =>
      normalizeWorkspaceUrl("http://[2606:4700:4700::1111]:3131"),
    ).toThrow(/https:\/\//i);
    expect(normalizeWorkspaceUrl("http://[::1]:3131").origin).toBe(
      "http://[::1]:3131",
    );
    expect(normalizeWorkspaceUrl("http://[fd12:3456::1]:3131").origin).toBe(
      "http://[fd12:3456::1]:3131",
    );
  });

  it("extracts Loop session cookies (__Host-loop and loop_local)", () => {
    expect(
      extractSessionCookie("__Host-loop=abc123; Path=/; HttpOnly; Secure"),
    ).toBe("__Host-loop=abc123");
    expect(extractSessionCookie("loop_local=xyz789; Path=/; HttpOnly")).toBe(
      "loop_local=xyz789",
    );
  });

  it("rejects malformed #fleet= JSON and invalid #pair= tokens with clear errors", () => {
    // base64url("null") === "bnVsbA"
    expect(() =>
      tryParsePairingLink("https://example.trycloudflare.com/#fleet=bnVsbA"),
    ).toThrow(/payload is invalid/i);

    expect(() =>
      tryParsePairingLink("https://example.trycloudflare.com/#pair=too-short"),
    ).toThrow(/invalid `#pair=` token/i);
  });

  it("rejects redirected or cross-origin probe responses", () => {
    expect(() =>
      assertSameOriginResponse(
        { redirected: true, url: "https://other.example.com/session" },
        "https://typed.example.com",
      ),
    ).toThrow(/redirect/i);

    expect(() =>
      assertSameOriginResponse(
        { redirected: false, url: "https://other.example.com/session" },
        "https://typed.example.com",
      ),
    ).toThrow(/origin/i);

    expect(() =>
      assertSameOriginResponse(
        { redirected: false, url: "https://typed.example.com/session" },
        "https://typed.example.com",
      ),
    ).not.toThrow();
  });
});

describe("mobile unified feed merging & truncation detection", () => {
  it("merges Done cards and Reply cards newest-first while preserving unread and keys", () => {
    const olderDone = makeFeedItem({
      conversation_id: "conv-old",
      done_card_key: "done:old",
      read_at: 999,
      last_activity_at: 1000,
      last_message: {
        id: "m-old",
        role: "assistant",
        content: "Older done result",
        created_at: 1000,
        saved: false,
      },
    });
    const duplicateDone = makeFeedItem({
      conversation_id: "conv-shared",
      done_card_key: "done:shared",
      read_at: 1500,
      last_activity_at: 1500,
      last_message: {
        id: "m-shared",
        role: "assistant",
        content: "Shared answer",
        created_at: 1500,
        saved: false,
      },
    });
    const matchingReply = makeFeedItem({
      conversation_id: "conv-shared",
      done_card_key: undefined,
      reply_card_key: "reply:m-shared",
      read_at: undefined,
      reply: { message_id: "q1", content: "Can you check?", read_at: null },
      last_activity_at: 2000,
      last_message: {
        id: "m-shared",
        role: "assistant",
        preview: "Shared answer",
        created_at: 2000,
        saved: false,
      },
    });

    const merged = mergeUnifiedFeedCards(
      [olderDone, duplicateDone],
      [matchingReply],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].conversationId).toBe("conv-shared");
    expect(merged[0].unread).toBe(true);
    expect(merged[0].doneUnread).toBe(false);
    expect(merged[0].replyUnread).toBe(true);
    expect(merged[0].doneCardKey).toBe("done:shared");
    expect(merged[0].replyCardKey).toBe("reply:m-shared");
    expect(getCardDismissTargets(merged[0])).toEqual({
      doneKey: "done:shared",
      replyMessageId: "m-shared",
    });
    expect(merged[1].conversationId).toBe("conv-old");
    expect(merged[1].unread).toBe(false);
    expect(merged[1].doneUnread).toBe(false);
  });

  it("flags 1000-char reply previews as truncated so carousel hydrates full content", () => {
    const reply = makeFeedItem({
      done_card_key: undefined,
      reply_card_key: "reply:long",
      reply: { message_id: "q2", content: "Explain", read_at: null },
      last_message: {
        id: "m-long",
        role: "assistant",
        preview: "x".repeat(1000),
        created_at: 3000,
        saved: false,
      },
    });
    const card = feedItemToNativeCard(reply, "replies");
    expect(card.bodyTruncated).toBe(true);
    expect(card.unread).toBe(true);
  });
});
