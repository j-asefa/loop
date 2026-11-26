import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUncertainOutcomeError,
  LoopApiError,
  LoopClient,
} from "../apps/mobile/src/api/client.js";
import {
  formatFileBytes,
  isPreviewableImageMime,
  isPreviewableTextMime,
  parseArtifactFileMetadata,
  resolveLoopFileTarget,
  sanitizeDownloadFilename,
} from "../apps/mobile/src/api/files.js";
import {
  applyLiveStreamBatch,
  applyLiveStreamEvent,
  buildAgentQueuedRuns,
  canPauseRun,
  clearRunFromLiveStreams,
  extractLiveStreamEvents,
  isNativeHarnessConnection,
  pruneLiveStreams,
  shouldRefreshForFrame,
  utf8ByteLength,
  type LiveStreamOverlay,
} from "../apps/mobile/src/api/socket.js";
import {
  assertSameOriginResponse,
  extractSessionCookie,
  normalizeWorkspaceUrl,
  tryParsePairingLink,
} from "../apps/mobile/src/api/pairing-url.js";
import {
  feedItemToNativeCard,
  feedPreviewText,
  getCardDismissTargets,
  mergeCarouselCards,
  mergeUnifiedFeedCards,
  type NativeResultCard,
} from "../apps/mobile/src/fixtures.js";
import {
  ActionKeyStore,
  runSaveToggle,
  ThreadRefreshGate,
  WorkspaceLoadCoordinator,
} from "../apps/mobile/src/workspace-runtime.js";
import {
  avatarColors,
  DARK_THEME,
  LIGHT_THEME,
  type LoopTheme,
} from "../apps/mobile/src/theme.js";
import { getAgentArt, PALETTES } from "../apps/mobile/src/agentArt.js";
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

describe("mobile production workspace runtime & feed previews", () => {
  it("strips long and unclosed fenced spec/code blocks from feedPreviewText", () => {
    const longJsonFence =
      "Summary sentence.\n```spec\n" +
      '{"op":"add","path":"/elements/x","value":"' +
      "a".repeat(900) +
      '"}\n```\nClosing takeaway.';
    const preview = feedPreviewText(longJsonFence);
    expect(preview).toContain("Summary sentence.");
    expect(preview).toContain("Closing takeaway.");
    expect(preview).not.toContain('"op"');
    expect(preview).not.toContain("```");

    const unclosedFence = "Intro line.\n```json\n" + '{"secret":"raw"}';
    expect(feedPreviewText(unclosedFence)).toBe("Intro line.");
  });

  it("ActionKeyStore reuses keys on retries, separates different decision answers, and resets on workspace switch", () => {
    let seq = 0;
    const store = new ActionKeyStore(() => `key-${++seq}`);

    const approveScope = store.scopeForApproval("a1", "approve");
    const rejectScope = store.scopeForApproval("a1", "reject");
    expect(store.getOrCreate(approveScope)).toBe("key-1");
    expect(store.getOrCreate(approveScope)).toBe("key-1");
    expect(store.getOrCreate(rejectScope)).toBe("key-2");

    // Same decision answer with different key order reuses the same commandId
    const decScopeA1 = store.scopeForDecision("d1", { b: 2, a: 1 });
    const decScopeA2 = store.scopeForDecision("d1", { a: 1, b: 2 });
    const decScopeB = store.scopeForDecision("d1", { a: 99, b: 2 });
    expect(store.getOrCreate(decScopeA1)).toBe("key-3");
    expect(store.getOrCreate(decScopeA2)).toBe("key-3");
    expect(store.getOrCreate(decScopeB)).toBe("key-4");

    // Workspace switch clears all pending keys
    store.clear();
    expect(store.getOrCreate(approveScope)).toBe("key-5");
  });

  it("runSaveToggle preserves optimistic state on 408 timeout, rolls back on 400, and ignores stale generations", async () => {
    let localSaved = false;
    let uncertainCalls = 0;
    let definiteErrors = 0;
    let gen = 1;

    // 1. Uncertain 408 timeout: keeps optimistic true, invokes onUncertain, does not throw
    const outcome = await runSaveToggle({
      nextSaved: true,
      generation: gen,
      getGeneration: () => gen,
      applyLocal: (v) => {
        localSaved = v;
      },
      commit: async () => {
        throw new LoopApiError(408, "Timeout");
      },
      onSuccess: () => {},
      onUncertain: () => {
        uncertainCalls += 1;
      },
      onDefiniteError: () => {
        definiteErrors += 1;
      },
    });
    expect(outcome).toBe("uncertain");
    expect(localSaved).toBe(true);
    expect(uncertainCalls).toBe(1);
    expect(definiteErrors).toBe(0);

    // 2. Definite 400 rejection: rolls back to false, calls onDefiniteError, and rethrows
    localSaved = false;
    await expect(
      runSaveToggle({
        nextSaved: true,
        generation: gen,
        getGeneration: () => gen,
        applyLocal: (v) => {
          localSaved = v;
        },
        commit: async () => {
          throw new LoopApiError(400, "Invalid message");
        },
        onSuccess: () => {},
        onUncertain: () => {
          uncertainCalls += 1;
        },
        onDefiniteError: () => {
          definiteErrors += 1;
        },
      }),
    ).rejects.toThrow(/Invalid message/);
    expect(localSaved).toBe(false);
    expect(definiteErrors).toBe(1);

    // 3. Stale generation (workspace switched mid-flight): ignores error without rollback
    localSaved = false;
    const staleOutcome = await runSaveToggle({
      nextSaved: true,
      generation: gen,
      getGeneration: () => gen,
      applyLocal: (v) => {
        localSaved = v;
      },
      commit: async () => {
        gen += 1;
        throw new LoopApiError(400, "Old workspace");
      },
      onSuccess: () => {},
      onUncertain: () => {},
      onDefiniteError: () => {
        definiteErrors += 1;
      },
    });
    expect(staleOutcome).toBe("stale");
    expect(definiteErrors).toBe(1);
  });

  it("WorkspaceLoadCoordinator coalesces overlapping refreshes, aborts on refreshSession 401, and drops stale workspace results", async () => {
    const coord = new WorkspaceLoadCoordinator();
    const refreshingLog: boolean[] = [];
    let fetchCount = 0;
    let releaseFirst!: () => void;

    const first = coord.run(
      { silent: true },
      {
        setRefreshing: (v) => refreshingLog.push(v),
        refreshSession: async () => {},
        fetchAll: async () => {
          fetchCount += 1;
          if (fetchCount === 1) {
            await new Promise<void>((r) => {
              releaseFirst = r;
            });
          }
        },
        onError: () => {},
      },
    );

    // Wait a tick for first refreshSession to finish and enter fetchAll
    await Promise.resolve();
    await Promise.resolve();

    // Overlapping pull-to-refresh coalesces and immediately surfaces spinner
    await coord.run(
      { silent: false },
      {
        setRefreshing: (v) => refreshingLog.push(v),
        refreshSession: async () => {},
        fetchAll: async () => {
          fetchCount += 1;
        },
        onError: () => {},
      },
    );
    expect(refreshingLog).toEqual([true]);

    releaseFirst();
    await first;
    // Let coalesced run complete
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCount).toBe(2);
    expect(refreshingLog[refreshingLog.length - 1]).toBe(false);

    // 401 from refreshSession aborts without calling fetchAll
    coord.reset();
    let batchCalledAfter401 = false;
    await coord.run(
      { silent: false },
      {
        setRefreshing: () => {},
        refreshSession: async () => {
          throw new LoopApiError(401, "Expired");
        },
        fetchAll: async () => {
          batchCalledAfter401 = true;
        },
        onError: () => {},
      },
    );
    expect(batchCalledAfter401).toBe(false);

    // Workspace switch mid-flight drops stale errors and unlocks new workspace immediately
    coord.reset();
    let staleErrorReported = false;
    let releaseStale!: () => void;
    const staleRun = coord.run(
      { silent: false },
      {
        setRefreshing: () => {},
        refreshSession: async () => {},
        fetchAll: async () => {
          await new Promise<void>((r) => {
            releaseStale = r;
          });
          throw new Error("Workspace A failed");
        },
        onError: () => {
          staleErrorReported = true;
        },
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    coord.reset();
    releaseStale();
    await staleRun;
    expect(staleErrorReported).toBe(false);
  });
});

describe("mobile sage & risograph palette themes", () => {
  it("exposes matching semantic tokens for sage light and dark ink themes", () => {
    const checkTheme = (t: LoopTheme) => {
      expect(t.bg).toMatch(/^#/);
      expect(t.surface).toMatch(/^#/);
      expect(t.brass).toBe("#e0a350");
      expect(t.onGreen).toMatch(/^#/);
      expect(t.onBlue).toMatch(/^#/);
      expect(t.unreadSurface).toMatch(/^#/);
      expect(t.unreadSurface).not.toBe(t.surface);
      expect(t.unreadLine).not.toBe(t.line);
      expect(t.purple).toMatch(/^#/);
      expect(t.rose).toMatch(/^#/);
      expect(t.tabBarBg).toMatch(/^rgba\(/);
    };
    expect(LIGHT_THEME.isDark).toBe(false);
    expect(LIGHT_THEME.bg).toBe("#7eb098");
    expect(LIGHT_THEME.brassText).not.toBe(LIGHT_THEME.brass);
    expect(LIGHT_THEME.greenSoft).toMatch(/^#/);
    expect(DARK_THEME.isDark).toBe(true);
    expect(DARK_THEME.bg).toBe("#171d1a");
    checkTheme(LIGHT_THEME);
    checkTheme(DARK_THEME);
  });

  it("maps agent avatars and Charley-Harper habitats to the coordinated palette", () => {
    expect(PALETTES).toHaveLength(9);
    for (const p of PALETTES) {
      expect(new Set([p.bg, p.main, p.dark, p.light, p.eye]).size).toBe(5);
      expect(p.bg).not.toBe(LIGHT_THEME.bg);
    }
    const willowArt = getAgentArt("@willow");
    const cedarArt = getAgentArt("cedar");
    expect(willowArt.avatarSvg).toContain(willowArt.palette.bg);
    expect(cedarArt.coverSvg).toContain(cedarArt.palette.main);
    expect(avatarColors("@willow")).toEqual({ bg: "#e098a8", fg: "#1c211e" });
    expect(avatarColors("unknown-agent")).toEqual({
      bg: "#32884a",
      fg: "#fcfbf7",
    });
  });
});

describe("mobile agent-published file resolution, metadata, and client APIs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves relative and same-origin Loop artifact/object links while rejecting cross-origin URLs", () => {
    const origin = "https://loop.example.com";

    expect(resolveLoopFileTarget("/?artifact=art-123", origin)).toEqual({
      kind: "artifact",
      id: "art-123",
      sourceId: undefined,
      path: "/api/artifacts/art-123/file",
    });
    expect(
      resolveLoopFileTarget(
        "https://loop.example.com/?artifact=art-123",
        origin,
      ),
    ).toEqual({
      kind: "artifact",
      id: "art-123",
      sourceId: undefined,
      path: "/api/artifacts/art-123/file",
    });
    expect(
      resolveLoopFileTarget("/api/artifacts/art-456/download", origin),
    ).toEqual({
      kind: "artifact",
      id: "art-456",
      sourceId: undefined,
      path: "/api/artifacts/art-456/file",
    });
    expect(
      resolveLoopFileTarget(
        "/api/agent-sources/peer-1/artifacts/art-789/file?preview=1",
        origin,
      ),
    ).toEqual({
      kind: "artifact",
      id: "art-789",
      sourceId: "peer-1",
      path: "/api/agent-sources/peer-1/artifacts/art-789/file",
    });
    expect(resolveLoopFileTarget("/api/objects/obj-99", origin)).toEqual({
      kind: "object",
      id: "obj-99",
      sourceId: undefined,
      path: "/api/objects/obj-99",
    });

    // Reject cross-origin and protocol-relative URLs so cookies are never leaked
    expect(
      resolveLoopFileTarget(
        "https://evil.example.com/api/artifacts/a1/file",
        origin,
      ),
    ).toBeNull();
    expect(
      resolveLoopFileTarget("//evil.example.com/api/artifacts/a1/file", origin),
    ).toBeNull();
    expect(
      resolveLoopFileTarget("https://github.com/j-asefa/loop", origin),
    ).toBeNull();
  });

  it("parses JSON metadata from /api/runs/:id/files and /api/me/files and sanitizes download filenames", () => {
    const meta = parseArtifactFileMetadata(
      JSON.stringify({
        name: "mackerel-report.pdf",
        mime: "application/pdf",
        size: 245_760,
        text: false,
      }),
      "Fallback Title",
    );
    expect(meta).toEqual({
      name: "mackerel-report.pdf",
      mime: "application/pdf",
      size: 245_760,
      isText: false,
    });
    expect(formatFileBytes(meta.size)).toBe("240 KB");
    expect(isPreviewableImageMime("image/png", "chart.png")).toBe(true);
    expect(isPreviewableTextMime("text/markdown", "notes.md")).toBe(true);
    expect(isPreviewableTextMime("text/html", "report.html")).toBe(false);
    expect(sanitizeDownloadFilename("../../etc/passwd", "id1")).toBe("passwd");
    expect(sanitizeDownloadFilename("   ", "id1")).toBe("loop-id1");
  });

  it("parses runFiles and personalFiles and rejects non-/api paths in sameOriginFileUrl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/runs/run-1/files",
        text: async () =>
          JSON.stringify([
            {
              id: "art-1",
              title: "Analysis chart",
              metadata: JSON.stringify({
                name: "chart.png",
                mime: "image/png",
                size: 4096,
              }),
            },
          ]),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/me/files",
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: "art-2",
                title: "Export CSV",
                metadata: JSON.stringify({
                  name: "export.csv",
                  mime: "text/csv",
                  size: 1200,
                  text: true,
                }),
                created_at: 5000,
                conversation_id: "conv-9",
                agent_name: "mackerel",
                project_name: "Loop",
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

    const runFiles = await client.runFiles("run-1");
    expect(runFiles).toEqual([
      {
        id: "art-1",
        artifactId: "art-1",
        title: "Analysis chart",
        name: "chart.png",
        mime: "image/png",
        size: 4096,
        isText: false,
        path: "/api/artifacts/art-1/file",
      },
    ]);

    const meFiles = await client.personalFiles();
    expect(meFiles).toEqual([
      {
        id: "art-2",
        artifactId: "art-2",
        title: "Export CSV",
        name: "export.csv",
        mime: "text/csv",
        size: 1200,
        isText: true,
        path: "/api/artifacts/art-2/file",
        conversationId: "conv-9",
        agentName: "mackerel",
        projectName: "Loop",
        createdAt: 5000,
      },
    ]);

    expect(
      client.sameOriginFileUrl("/api/artifacts/art-1/file", "preview=1"),
    ).toBe("https://loop.example.com/api/artifacts/art-1/file?preview=1");
    expect(() =>
      client.sameOriginFileUrl(
        "https://evil.example.com/api/artifacts/a1/file",
      ),
    ).toThrow(/unsupported/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("mobile live run streaming & run controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts and reduces message.delta, activity.updated, native.event, and terminal run state frames", () => {
    const deltaFrame = JSON.stringify({
      v: 3,
      type: "events",
      events: [
        {
          id: 1,
          event: {
            type: "activity.updated",
            scope: { kind: "run", id: "run-1" },
            payload: { key: "k1", kind: "tool", sequence: 1 },
          },
        },
        {
          id: 2,
          event: {
            type: "message.delta",
            scope: { kind: "run", id: "run-1" },
            payload: {
              messageId: "m-1",
              conversationId: "conv-1",
              text: "Hello ",
            },
          },
        },
        {
          id: 3,
          event: {
            type: "message.delta",
            scope: { kind: "run", id: "run-1" },
            payload: {
              messageId: "m-1",
              conversationId: "conv-1",
              text: "world!",
            },
          },
        },
      ],
    });

    const events = extractLiveStreamEvents(deltaFrame);
    expect(events).toHaveLength(3);
    let overlay = undefined;
    for (const ev of events) {
      overlay = applyLiveStreamEvent(overlay, ev, 1000) ?? undefined;
    }
    expect(overlay).toEqual({
      runId: "run-1",
      text: "Hello world!",
      messageId: "m-1",
      activity: "Running tool…",
      state: "running",
      revision: undefined,
      byteEnd: 12,
      gapped: false,
      updatedAt: 1000,
    });

    // Terminal state clears the live overlay so stale text never lingers
    const doneEvents = extractLiveStreamEvents(
      JSON.stringify({
        v: 3,
        type: "events",
        events: [
          {
            id: 4,
            event: {
              type: "completed",
              scope: { kind: "run", id: "run-1" },
              payload: { runId: "run-1" },
            },
          },
        ],
      }),
    );
    expect(applyLiveStreamEvent(overlay, doneEvents[0], 2000)).toBeNull();
  });

  it("handles live overlay batching, terminal cleanup without conversationId, reset frames, offsets, and prototype safety", () => {
    // Prototype-keyed activity kinds (e.g. "constructor") are ignored safely
    const protoEvents = extractLiveStreamEvents(
      JSON.stringify({
        v: 3,
        type: "events",
        events: [
          {
            id: 1,
            event: {
              type: "activity.updated",
              scope: { kind: "run", id: "run-1" },
              payload: { kind: "constructor" },
            },
          },
          {
            id: 2,
            event: {
              type: "queued",
              scope: { kind: "run", id: "run-2" },
              payload: { conversationId: "conv-1" },
            },
          },
        ],
      }),
    );
    expect(protoEvents).toHaveLength(0);

    // Offset & revision handling prevents garbled text on overlapping replay or missed chunks
    let revOverlay: LiveStreamOverlay | undefined;
    revOverlay =
      applyLiveStreamEvent(
        revOverlay,
        {
          kind: "delta",
          runId: "run-1",
          messageId: "m-1",
          text: "Hello ",
          offset: 0,
          revision: 2,
        },
        10,
      ) ?? undefined;
    // Stale revision is ignored
    revOverlay =
      applyLiveStreamEvent(
        revOverlay,
        {
          kind: "delta",
          runId: "run-1",
          messageId: "m-1",
          text: "OLD",
          offset: 0,
          revision: 1,
        },
        11,
      ) ?? undefined;
    expect(revOverlay?.text).toBe("Hello ");
    // Overlapping replay deduplicates cleanly
    revOverlay =
      applyLiveStreamEvent(
        revOverlay,
        {
          kind: "delta",
          runId: "run-1",
          messageId: "m-1",
          text: "lo world",
          offset: 3,
          revision: 3,
        },
        12,
      ) ?? undefined;
    expect(revOverlay?.text).toBe("Hello world");
    expect(revOverlay?.gapped).toBe(false);
    // Gap beyond current length marks gapped instead of concatenating corrupted text
    revOverlay =
      applyLiveStreamEvent(
        revOverlay,
        {
          kind: "delta",
          runId: "run-1",
          messageId: "m-1",
          text: "after-gap",
          offset: 50,
          revision: 4,
        },
        13,
      ) ?? undefined;
    expect(revOverlay?.gapped).toBe(true);
    expect(revOverlay?.text).toBe("Hello world");
    // Full upsert clears the gap
    revOverlay =
      applyLiveStreamEvent(
        revOverlay,
        {
          kind: "delta",
          runId: "run-1",
          messageId: "m-1",
          text: "Full clean text",
          replace: true,
        },
        14,
      ) ?? undefined;
    expect(revOverlay?.gapped).toBe(false);
    expect(revOverlay?.text).toBe("Full clean text");

    // Batch reducer: cancelling queued run-2 does not clobber active run-1's conv overlay,
    // while completing run-1 (even without conversationId) clears BOTH run:run-1 and conv:conv-1.
    const map = new Map<string, LiveStreamOverlay>();
    const activeRuns = [
      { id: "run-1", conversation_id: "conv-1", state: "running" },
      { id: "run-2", conversation_id: "conv-1", state: "queued" },
    ];
    applyLiveStreamBatch(
      map,
      [
        {
          kind: "delta",
          runId: "run-1",
          conversationId: "conv-1",
          text: "Streaming…",
        },
      ],
      activeRuns,
      100,
    );
    expect(map.get("conv:conv-1")?.runId).toBe("run-1");

    // Cancelling run-2 in same conversation leaves run-1's conv overlay intact
    applyLiveStreamBatch(
      map,
      [
        {
          kind: "state",
          runId: "run-2",
          conversationId: "conv-1",
          state: "cancelled",
        },
      ],
      activeRuns,
      110,
    );
    expect(map.get("conv:conv-1")?.text).toBe("Streaming…");

    // Completing run-1 WITHOUT conversationId still deletes conv:conv-1
    applyLiveStreamBatch(
      map,
      [{ kind: "state", runId: "run-1", state: "completed" }],
      activeRuns,
      120,
    );
    expect(map.has("run:run-1")).toBe(false);
    expect(map.has("conv:conv-1")).toBe(false);

    // Reset frame clears all overlays; pruneLiveStreams & clearRunFromLiveStreams clean stale entries
    applyLiveStreamBatch(
      map,
      [{ kind: "delta", runId: "run-3", conversationId: "conv-3", text: "hi" }],
      [{ id: "run-3", conversation_id: "conv-3", state: "running" }],
      200,
    );
    expect(map.size).toBe(2);
    expect(extractLiveStreamEvents(JSON.stringify({ type: "reset" }))).toEqual([
      { kind: "reset" },
    ]);
    applyLiveStreamBatch(map, [{ kind: "reset" }], [], 210);
    expect(map.size).toBe(0);

    applyLiveStreamBatch(
      map,
      [
        { kind: "delta", runId: "run-4", conversationId: "conv-4", text: "a" },
        { kind: "delta", runId: "run-5", conversationId: "conv-5", text: "b" },
      ],
      [
        { id: "run-4", conversation_id: "conv-4", state: "running" },
        { id: "run-5", conversation_id: "conv-5", state: "running" },
      ],
      300,
    );
    expect(clearRunFromLiveStreams(map, "run-4", "conv-4")).toBe(true);
    expect(map.has("run:run-4")).toBe(false);
    expect(map.has("conv:conv-4")).toBe(false);
    expect(map.has("run:run-5")).toBe(true);
    expect(pruneLiveStreams(map, [])).toBe(true);
    expect(map.size).toBe(0);
  });

  it("refuses Pause for native-harness connections while allowing Pause for API-backed runs", () => {
    const connections = [
      {
        id: "conn-native",
        metadata: JSON.stringify({ loopHarness: "claude-code" }),
      },
      { id: "conn-api", metadata: JSON.stringify({ kind: "anthropic" }) },
    ];
    const agents = [
      { id: "a-native", connection_id: "conn-native" },
      { id: "a-api", connection_id: "conn-api" },
    ];
    expect(isNativeHarnessConnection(connections[0])).toBe(true);
    expect(isNativeHarnessConnection(connections[1])).toBe(false);
    expect(
      canPauseRun(
        { state: "running", agent_id: "a-native" },
        agents,
        connections,
      ),
    ).toBe(false);
    expect(
      canPauseRun({ state: "running", agent_id: "a-api" }, agents, connections),
    ).toBe(true);
    expect(
      canPauseRun({ state: "paused", agent_id: "a-api" }, agents, connections),
    ).toBe(false);
    // Run-level connection_id overrides agent's current connection_id
    expect(
      canPauseRun(
        { state: "running", agent_id: "a-api", connection_id: "conn-native" },
        agents,
        connections,
      ),
    ).toBe(false);
  });

  it("tracks UTF-8 byte offsets accurately across multi-byte text, mid-reply joins, and >80k streams", () => {
    // Em-dash (3 bytes), accented é (2 bytes), rocket emoji 🚀 (4 bytes)
    expect(utf8ByteLength("café — 🚀")).toBe(
      Buffer.byteLength("café — 🚀", "utf8"),
    );

    // Multi-byte continuation uses UTF-8 bytes, never UTF-16 code units
    const chunk1 = "café — 🚀 ";
    const chunk1Bytes = Buffer.byteLength(chunk1, "utf8"); // 13 bytes vs 10 UTF-16 chars
    let ov: LiveStreamOverlay | undefined;
    ov =
      applyLiveStreamEvent(
        ov,
        {
          kind: "delta",
          runId: "r-utf8",
          messageId: "m-utf8",
          text: chunk1,
          offset: 0,
          revision: 1,
        },
        1,
      ) ?? undefined;
    expect(ov?.byteEnd).toBe(chunk1Bytes);
    ov =
      applyLiveStreamEvent(
        ov,
        {
          kind: "delta",
          runId: "r-utf8",
          messageId: "m-utf8",
          text: "done!",
          offset: chunk1Bytes,
          revision: 2,
        },
        2,
      ) ?? undefined;
    expect(ov?.gapped).toBe(false);
    expect(ov?.text).toBe("café — 🚀 done!");

    // Joining mid-reply (offset > 0 with no prior text) streams cleanly without marking gapped
    let mid: LiveStreamOverlay | undefined;
    mid =
      applyLiveStreamEvent(
        mid,
        {
          kind: "delta",
          runId: "r-mid",
          messageId: "m-mid",
          text: "tail part 1 ",
          offset: 400,
          revision: 10,
        },
        10,
      ) ?? undefined;
    expect(mid?.gapped).toBe(false);
    expect(mid?.byteEnd).toBe(400 + Buffer.byteLength("tail part 1 ", "utf8"));
    mid =
      applyLiveStreamEvent(
        mid,
        {
          kind: "delta",
          runId: "r-mid",
          messageId: "m-mid",
          text: "tail part 2",
          offset: 412,
          revision: 11,
        },
        11,
      ) ?? undefined;
    expect(mid?.gapped).toBe(false);
    expect(mid?.text).toBe("tail part 1 tail part 2");

    // Streams past 80,000 chars keep advancing byteEnd without falsely setting gapped
    const big = "a".repeat(80_010);
    let longOv: LiveStreamOverlay | undefined;
    longOv =
      applyLiveStreamEvent(
        longOv,
        {
          kind: "delta",
          runId: "r-big",
          messageId: "m-big",
          text: big,
          offset: 0,
          revision: 1,
        },
        1,
      ) ?? undefined;
    expect(longOv?.text.length).toBe(80_000);
    expect(longOv?.byteEnd).toBe(80_010);
    longOv =
      applyLiveStreamEvent(
        longOv,
        {
          kind: "delta",
          runId: "r-big",
          messageId: "m-big",
          text: "XYZ",
          offset: 80_010,
          revision: 2,
        },
        2,
      ) ?? undefined;
    expect(longOv?.gapped).toBe(false);
    expect(longOv?.text.endsWith("XYZ")).toBe(true);
    expect(longOv?.byteEnd).toBe(80_013);
  });

  it("merges item.queued_runs, item.run, and activeRuns in server queue_position order and ignores stale run upserts", () => {
    const feedItems: ApiFeedItem[] = [
      makeFeedItem({
        conversation_id: "conv-open",
        title: "Open thread",
        agent_id: "a1",
        run: { id: "r-running", state: "running", input: "Working" },
        queued_runs: [
          {
            id: "q-1",
            input: "Follow-up 1 on open thread",
            created_at: 200,
            queue_position: 1,
            can_move_up: false,
            can_move_down: true,
          },
        ],
      }),
      makeFeedItem({
        conversation_id: "conv-other",
        title: "Other thread",
        agent_id: "a1",
        run: {
          id: "q-2",
          state: "queued",
          input: "Task on other thread",
          created_at: 100,
          queue_position: 2,
          can_move_up: true,
          can_move_down: false,
        },
      }),
    ];
    const activeRuns = [
      {
        id: "r-running",
        agent_id: "a1",
        conversation_id: "conv-open",
        input: "Working",
        state: "running",
        created_at: 50,
      },
      {
        id: "q-1",
        agent_id: "a1",
        conversation_id: "conv-open",
        input: "Follow-up 1 on open thread",
        state: "queued",
        created_at: 200,
      },
      {
        id: "q-3",
        agent_id: "a1",
        conversation_id: "conv-open",
        input: "Brand new queued follow-up",
        state: "queued",
        created_at: 300,
      },
    ];

    const queued = buildAgentQueuedRuns(
      "a1",
      "conv-open",
      feedItems,
      activeRuns,
    );
    expect(queued.map((q) => q.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect(queued[0]).toMatchObject({
      can_move_up: false,
      can_move_down: true,
      threadTitle: undefined,
    });
    expect(queued[1]).toMatchObject({
      can_move_up: true,
      can_move_down: false,
      threadTitle: "Other thread",
    });
    expect(queued[2]).toMatchObject({
      can_move_up: false,
      can_move_down: false,
    });

    // Late message.upsert from an older non-active run does not overwrite the active run's stream
    const map = new Map<string, LiveStreamOverlay>();
    applyLiveStreamBatch(
      map,
      [
        {
          kind: "delta",
          runId: "r-running",
          conversationId: "conv-open",
          text: "Live answer",
        },
        {
          kind: "delta",
          runId: "r-old-finished",
          conversationId: "conv-open",
          text: "Stale upsert",
          replace: true,
        },
      ],
      activeRuns,
      500,
    );
    expect(map.get("conv:conv-open")?.text).toBe("Live answer");
  });

  it("submits steer vs queue flags, pause/resume/retry actions, and queue reorders with durable keys", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      url: "https://loop.example.com/api/runs",
      text: async () => JSON.stringify({ id: "r-new", ok: true }),
    } as unknown as Response);

    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-1",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });

    await client.submitRun({
      agentId: "a1",
      conversationId: "c1",
      input: "Steer now",
      queue: false,
      idempotencyKey: "steer-key-1234",
    });
    await client.submitRun({
      agentId: "a1",
      conversationId: "c1",
      input: "Queue later",
      queue: true,
      idempotencyKey: "queue-key-1234",
    });
    await client.runAction("r1", "pause", "pause-key-1234");
    await client.runAction("r1", "resume", "resume-key-1234");
    await client.runAction("r1", "retry", "retry-key-1234");
    await client.reorderRun("r2", "up", "reorder-key-1234");

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      queue: false,
      idempotencyKey: "steer-key-1234",
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({
      queue: true,
      idempotencyKey: "queue-key-1234",
    });
    expect(fetchSpy.mock.calls[2][0]).toBe(
      "https://loop.example.com/api/runs/r1/pause",
    );
    expect(fetchSpy.mock.calls[3][0]).toBe(
      "https://loop.example.com/api/runs/r1/resume",
    );
    expect(fetchSpy.mock.calls[4][0]).toBe(
      "https://loop.example.com/api/runs/r1/retry",
    );
    expect(fetchSpy.mock.calls[5][0]).toBe(
      "https://loop.example.com/api/runs/r2/reorder",
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[5][1]?.body))).toEqual({
      direction: "up",
      idempotencyKey: "reorder-key-1234",
    });

    const store = new ActionKeyStore(() => "durable-1");
    expect(store.scopeForRunAction("r1", "retry")).toBe("run-retry:r1");
    expect(store.scopeForRunReorder("r2", "up")).toBe("run-reorder:r2:up");
    expect(store.getOrCreate(store.scopeForRunAction("r1", "retry"))).toBe(
      "durable-1",
    );
  });
});

describe("mobile open thread refresh", () => {
  it("shows the spinner only on a conversation's first load", () => {
    const gate = new ThreadRefreshGate();
    const first = gate.begin("conv-1");
    expect(first.showSpinner).toBe(true);
    expect(gate.accept(first.token, "conv-1")).toBe(true);

    // Workspace refreshes and post-send reloads swap content in place.
    const again = gate.begin("conv-1");
    expect(again.showSpinner).toBe(false);
    expect(gate.accept(again.token, "conv-1")).toBe(true);

    expect(gate.begin("conv-2").showSpinner).toBe(true);
  });

  it("keeps loaded messages when a background refresh fails", () => {
    const gate = new ThreadRefreshGate();
    const first = gate.begin("conv-1");
    expect(gate.showError(first.token, "conv-1")).toBe(true);

    const retry = gate.begin("conv-1");
    gate.accept(retry.token, "conv-1");
    const background = gate.begin("conv-1");
    expect(gate.showError(background.token, "conv-1")).toBe(false);
  });

  it("drops a response that an overlapping refresh superseded", () => {
    const gate = new ThreadRefreshGate();
    const older = gate.begin("conv-1");
    const newer = gate.begin("conv-1");
    expect(gate.accept(older.token, "conv-1")).toBe(false);
    expect(gate.isLatest(older.token)).toBe(false);
    expect(gate.accept(newer.token, "conv-1")).toBe(true);
  });
});
