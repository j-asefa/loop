import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUncertainOutcomeError,
  LoopApiError,
  LoopClient,
} from "../apps/mobile/src/api/client.js";
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
  mergeCarouselCards,
  mergeUnifiedFeedCards,
  type NativeResultCard,
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

  it("rejects cleartext http:// for public IPv6 literals and dotless numeric IPv4 while allowing ::1 and IPv6 ULA", () => {
    expect(() =>
      normalizeWorkspaceUrl("http://[2606:4700:4700::1111]:3131"),
    ).toThrow(/https:\/\//i);
    expect(() => normalizeWorkspaceUrl("http://134744072:3131")).toThrow(
      /https:\/\//i,
    );
    expect(() => normalizeWorkspaceUrl("http://0x08080808:3131")).toThrow(
      /https:\/\//i,
    );
    expect(normalizeWorkspaceUrl("http://[::1]:3131").origin).toBe(
      "http://[::1]:3131",
    );
    expect(normalizeWorkspaceUrl("http://[fd12:3456::1]:3131").origin).toBe(
      "http://[fd12:3456::1]:3131",
    );
  });

  it("extracts Loop session cookies including hashed isolated-workspace names", () => {
    expect(
      extractSessionCookie("__Host-loop=abc123; Path=/; HttpOnly; Secure"),
    ).toBe("__Host-loop=abc123");
    expect(extractSessionCookie("loop_local=xyz789; Path=/; HttpOnly")).toBe(
      "loop_local=xyz789",
    );
    expect(
      extractSessionCookie(
        "__Host-loop_0123456789abcdef01234567=iso1; Path=/; HttpOnly; Secure",
      ),
    ).toBe("__Host-loop_0123456789abcdef01234567=iso1");
    expect(
      extractSessionCookie(
        "loop_local_0123456789abcdef01234567=iso2; Path=/; HttpOnly",
      ),
    ).toBe("loop_local_0123456789abcdef01234567=iso2");
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

describe("mobile carousel override merging", () => {
  const baseCard: NativeResultCard = {
    id: "done:old",
    conversationId: "conv-1",
    tab: "done",
    agentId: "agent-1",
    agentName: "ebony",
    projectName: "Loop",
    model: "claude-sonnet-4",
    prompt: "Old prompt",
    fallbackTitle: "Old title",
    body: "Old body",
    createdAt: 1000,
    saved: false,
    unread: false,
    messageId: "m-old",
    doneCardKey: "done:old",
  };

  it("drops synthetic working override once a finished Done card arrives for the same run or newer time", () => {
    const workingOverride: NativeResultCard = {
      ...baseCard,
      id: "working:run-2",
      tab: "working",
      body: "Working…",
      createdAt: 2000,
      messageId: undefined,
      doneCardKey: undefined,
      runId: "run-2",
    };

    // While still running, the synthetic working card leads above older Done cards.
    const whileRunning = mergeCarouselCards([baseCard], [workingOverride]);
    expect(whileRunning.map((c) => c.id)).toEqual([
      "working:run-2",
      "done:old",
    ]);

    // Once finished, the live Done card replaces the working placeholder at index 0.
    const finishedCard: NativeResultCard = {
      ...baseCard,
      id: "done:new",
      body: "Finished answer",
      createdAt: 2500,
      messageId: "m-new",
      doneCardKey: "done:new",
      runId: "run-2",
    };
    const afterFinish = mergeCarouselCards(
      [finishedCard, baseCard],
      [workingOverride],
    );
    expect(afterFinish.map((c) => c.id)).toEqual(["done:new", "done:old"]);
  });

  it("places newly arrived live replies ahead of an AgentProfileSheet seed card", () => {
    const seedCard: NativeResultCard = {
      ...baseCard,
      id: "done:seed",
      messageId: "m-seed",
      createdAt: 1500,
    };
    const newReply: NativeResultCard = {
      ...baseCard,
      id: "done:reply",
      messageId: "m-reply",
      createdAt: 3000,
    };
    const merged = mergeCarouselCards([newReply], [seedCard]);
    expect(merged.map((c) => c.id)).toEqual(["done:reply", "done:seed"]);
  });
});

describe("mobile LoopClient redirect, timeout, and doneCards contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends redirect:'error' and rejects cross-origin responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      redirected: true,
      url: "https://evil.example.com/api/bootstrap",
      text: async () => "{}",
    } as unknown as Response);

    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-1",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });

    await expect(client.bootstrap()).rejects.toThrow(/redirect/i);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://loop.example.com/api/bootstrap",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("classifies 408/5xx/network aborts as uncertain outcomes and 4xx rejections as definite", async () => {
    expect(isUncertainOutcomeError(new LoopApiError(408, "Timeout"))).toBe(
      true,
    );
    expect(isUncertainOutcomeError(new LoopApiError(503, "Unavailable"))).toBe(
      true,
    );
    expect(
      isUncertainOutcomeError(new TypeError("Network request failed")),
    ).toBe(true);
    expect(isUncertainOutcomeError(new LoopApiError(400, "Bad request"))).toBe(
      false,
    );
    expect(isUncertainOutcomeError(new LoopApiError(409, "Conflict"))).toBe(
      false,
    );

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );
    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-1",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });
    const err = await client
      .decideApproval("apr-1", "approve", "idem-1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoopApiError);
    expect((err as LoopApiError).status).toBe(408);
    expect(isUncertainOutcomeError(err)).toBe(true);
  });

  it("reuses explicit idempotencyKey/commandId on runAction, decideApproval, and answerNativeDecision", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      url: "https://loop.example.com/api/runs/r1/cancel",
      text: async () => JSON.stringify({ ok: true, state: "answered" }),
    } as unknown as Response);

    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-1",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });

    await client.runAction("r1", "cancel", "fixed-cancel-key");
    await client.decideApproval("a1", "approve", "fixed-approval-key");
    await client.answerNativeDecision("d1", { ok: true }, "fixed-command-id");

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      idempotencyKey: "fixed-cancel-key",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
      decision: "approve",
      idempotencyKey: "fixed-approval-key",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[2][1]?.body))).toEqual({
      commandId: "fixed-command-id",
      answer: { ok: true },
    });
  });

  it("does not fabricate a d:-prefixed messageId and prefers full card.content in doneCards", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      url: "https://loop.example.com/api/v1/cards?view=done&limit=60",
      text: async () =>
        JSON.stringify({
          items: [
            {
              card: {
                id: "d:conv-1:done:1",
                type: "done",
                content: "Rendered body without last_message",
                created_at: 2000,
                saved: false,
                display: {
                  conversation_id: "conv-1",
                  title: "Title",
                  agent_id: "a1",
                  agent_name: "ebony",
                  done_card_key: "done:1",
                  read_at: null,
                  last_activity_at: 2000,
                  last_message: null,
                  pending_approvals: 0,
                },
              },
            },
            {
              card: {
                id: "d:conv-2:done:2",
                type: "done",
                content: "Full untruncated body from v1 cards endpoint",
                created_at: 2100,
                saved: true,
                display: {
                  conversation_id: "conv-2",
                  title: "Title 2",
                  agent_id: "a1",
                  agent_name: "ebony",
                  done_card_key: "done:2",
                  read_at: null,
                  last_activity_at: 2100,
                  last_message: {
                    id: "msg-2",
                    role: "assistant",
                    content: "Short truncated",
                    created_at: 2100,
                    saved: false,
                  },
                  pending_approvals: 0,
                },
              },
            },
          ],
        }),
    } as unknown as Response);

    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-1",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });
    const items = await client.doneCards();
    expect(items).toHaveLength(2);
    expect(items[0].last_message).toBeNull();
    expect(items[0].live_preview).toBe("Rendered body without last_message");
    const card0 = feedItemToNativeCard(items[0], "done");
    expect(card0.messageId).toBeUndefined();
    expect(card0.body).toBe("Rendered body without last_message");

    const card1 = feedItemToNativeCard(items[1], "done");
    expect(card1.messageId).toBe("msg-2");
    expect(card1.body).toBe("Full untruncated body from v1 cards endpoint");
    expect(card1.saved).toBe(true);
  });
});
