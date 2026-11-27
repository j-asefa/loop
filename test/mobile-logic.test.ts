import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleInput } from "../src/shared/mobile-contract-schemas.js";
import {
  CopySessionTracker,
  hasInteractiveInlineLink,
  resolveInlineTextSelectable,
  shouldShowPreviewSelectToggle,
} from "../apps/mobile/src/text-selection.js";
import {
  ShareInput,
  ShareSendInput,
} from "../src/shared/team-contract-schemas.js";
import {
  isUncertainOutcomeError,
  LoopApiError,
  LoopClient,
} from "../apps/mobile/src/api/client.js";
import {
  DEFAULT_NOTIFICATION_PREFS,
  detectNotificationEvents,
  MAX_NOTIFICATION_BURST,
  parseNotificationPrefs,
  parseNotificationTapTarget,
  serializeNotificationPrefs,
} from "../apps/mobile/src/notifications-prefs.js";
import {
  MAX_CACHED_AGENTS,
  MAX_CACHED_CARD_BODY_CHARS,
  MAX_CACHED_CARDS,
  OFFLINE_CACHE_TTL_MS,
  parseWorkspaceCache,
  serializeWorkspaceCache,
} from "../apps/mobile/src/offline-cache-codec.js";
import {
  buildShareSendPayload,
  classifyShareSendFailure,
  extractLeadingShareHandle,
  isSafeHttpUrl,
  isSafeLocalShareFileUri,
  normalizeIncomingSharePayloads,
} from "../apps/mobile/src/share-utils.js";
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
  assignPairingStorage,
  assertSameOriginResponse,
  extractSessionCookie,
  isSamePairedDevice,
  localDataScope,
  preserveProbedCredentials,
  normalizeWorkspaceUrl,
  tryParsePairingLink,
} from "../apps/mobile/src/api/pairing-url.js";
import {
  feedItemToNativeCard,
  feedPreviewText,
  getCardDismissTargets,
  mergeCarouselCards,
  mergeCarouselHistoryPage,
  openingCarouselCardIds,
  reconcileCarouselSaves,
  resolveCarouselSelection,
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
  createEmptyDraftMap,
  deleteDraftFromStore,
  DRAFT_TTL_MS,
  draftScopeForCarousel,
  draftScopeForCompose,
  draftScopeForShare,
  draftScopeForThread,
  draftWorkspaceBucket,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS_PER_WORKSPACE,
  parseDraftStore,
  readDraftEntryFromStore,
  readDraftFromStore,
  serializeDraftStore,
  setDraftInStore,
} from "../apps/mobile/src/drafts-codec.js";
import {
  buildSchedulePresets,
  buildVoiceRecordingFilename,
  computeCustomSendAt,
  formatScheduledTime,
  formatVoiceDuration,
  MAX_SCHEDULE_WINDOW_MS,
  MIN_SCHEDULE_LEAD_MS,
  validateSendAt,
} from "../apps/mobile/src/schedule-utils.js";
import {
  MAX_MERMAID_NODES,
  parseMermaidDiagram,
} from "../apps/mobile/src/mermaid-parser.js";
import {
  findInlineMathAt,
  formatLatexInline,
  parseLatexDisplayRows,
} from "../apps/mobile/src/latex-math.js";
import {
  avatarColors,
  DARK_THEME,
  LIGHT_THEME,
  type LoopTheme,
} from "../apps/mobile/src/theme.js";
import { getAgentArt, PALETTES } from "../apps/mobile/src/agentArt.js";
import {
  computeKeyboardInset,
  computeQuickSheetLayout,
  sortSnippetsByUsage,
} from "../apps/mobile/src/snippet-usage-codec.js";
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

describe("mobile garden palette themes", () => {
  it("exposes matching semantic tokens for the day and night themes", () => {
    const checkTheme = (t: LoopTheme) => {
      expect(t.bg).toMatch(/^#/);
      expect(t.surface).toMatch(/^#/);
      expect(t.brass).toMatch(/^#[0-9a-f]{6}$/);
      expect(t.onGreen).toMatch(/^#/);
      expect(t.onBlue).toMatch(/^#/);
      expect(t.unreadSurface).toMatch(/^#/);
      expect(t.unreadSurface).not.toBe(t.surface);
      expect(t.unreadLine).not.toBe(t.line);
      expect(t.purple).toMatch(/^#/);
      expect(t.rose).toMatch(/^#/);
      expect(t.tabBarBg).toMatch(/^#[0-9a-f]{6}$/);
    };
    expect(LIGHT_THEME.isDark).toBe(false);
    expect(LIGHT_THEME.bg).toBe("#7eb098");
    expect(LIGHT_THEME.brass).toBe("#e0a350");
    expect(LIGHT_THEME.brassText).not.toBe(LIGHT_THEME.brass);
    expect(LIGHT_THEME.greenSoft).toMatch(/^#/);
    expect(DARK_THEME.isDark).toBe(true);
    expect(DARK_THEME.bg).toBe("#101f19");
    expect(DARK_THEME.brass).toBe("#edc47e");
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
          id: 0,
          event: {
            type: "running",
            scope: { kind: "run", id: "run-1" },
            payload: { conversationId: "conv-1" },
          },
        },
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
    expect(events).toHaveLength(4);
    let overlay = undefined;
    for (const ev of events) {
      overlay = applyLiveStreamEvent(overlay, ev, 1000) ?? undefined;
    }
    expect(overlay).toMatchObject({
      runId: "run-1",
      text: "Hello world!",
      messageId: "m-1",
      activity: "Running tool…",
      state: "running",
      revision: undefined,
      byteEnd: 12,
      anchored: true,
      gapped: false,
      updatedAt: 1000,
    });

    // Terminal native.event status ("failed"/"completed"/"idle") emits a terminal state
    // rather than recreating a live "running" activity overlay.
    const terminalNative = extractLiveStreamEvents(
      JSON.stringify({
        v: 3,
        type: "events",
        events: [
          {
            id: 5,
            event: {
              type: "native.event",
              scope: { kind: "run", id: "run-1" },
              payload: { event: { type: "status", status: "failed" } },
            },
          },
        ],
      }),
    );
    expect(terminalNative).toEqual([
      {
        kind: "state",
        runId: "run-1",
        conversationId: undefined,
        state: "failed",
      },
    ]);
    expect(applyLiveStreamEvent(overlay, terminalNative[0], 1100)).toBeNull();

    // Unanchored native delta (e.g. opened mid-turn or right after a reconnect reset)
    // is marked gapped so a mid-stream fragment never replaces the card body.
    const midNative = applyLiveStreamEvent(
      undefined,
      {
        kind: "delta",
        runId: "run-native",
        messageId: "item-1",
        text: "partial tail fragment",
      },
      1500,
    );
    expect(midNative?.gapped).toBe(true);
    expect(midNative?.text).toBe("");

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
          kind: "state",
          runId: "run-1",
          conversationId: "conv-1",
          state: "running",
        },
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
    // Stale snapshot taken before run-5's delta arrived (250 < 300) must NOT prune run-5
    expect(pruneLiveStreams(map, [], 250)).toBe(false);
    expect(map.has("run:run-5")).toBe(true);
    // Newer snapshot (350 > 300) prunes finished run-5 cleanly
    expect(pruneLiveStreams(map, [], 350)).toBe(true);
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
      canPauseRun(
        { state: "waiting_children", agent_id: "a-native" },
        agents,
        connections,
      ),
    ).toBe(false);
    expect(
      canPauseRun(
        { state: "waiting_children", agent_id: "a-api" },
        agents,
        connections,
      ),
    ).toBe(true);
    expect(
      canPauseRun({ state: "paused", agent_id: "a-api" }, agents, connections),
    ).toBe(false);
    // Run-level JSON string payload (exact wire format from GET /api/runs PublicRun) overrides agent connection_id
    expect(
      canPauseRun(
        {
          state: "running",
          agent_id: "a-api",
          payload: JSON.stringify({ connectionId: "conn-native" }),
        },
        agents,
        connections,
      ),
    ).toBe(false);
    expect(
      canPauseRun(
        {
          state: "running",
          agent_id: "a-native",
          payload: JSON.stringify({ connectionId: "conn-api" }),
        },
        agents,
        connections,
      ),
    ).toBe(true);
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

    // Joining mid-reply or receiving offset > 0 after a reconnect reset marks gapped
    // rather than presenting a mid-stream fragment as the full reply body.
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
    expect(mid?.gapped).toBe(true);
    expect(mid?.text).toBe("");
    // A subsequent full message.upsert clears the gap cleanly
    mid =
      applyLiveStreamEvent(
        mid,
        {
          kind: "delta",
          runId: "r-mid",
          messageId: "m-mid",
          text: "Complete synced body",
          replace: true,
        },
        11,
      ) ?? undefined;
    expect(mid?.gapped).toBe(false);
    expect(mid?.text).toBe("Complete synced body");

    // Conversation-scoped production delta (no runId in frame) resolves via activeRuns,
    // and negative/fractional offsets are ignored cleanly.
    const convScopedEvents = extractLiveStreamEvents(
      JSON.stringify({
        v: 3,
        type: "events",
        events: [
          {
            id: 10,
            event: {
              type: "message.delta",
              scope: { kind: "conversation", id: "conv-prod" },
              payload: {
                messageId: "m-prod",
                conversationId: "conv-prod",
                text: "Hello ",
                offset: 0,
                revision: 1,
              },
            },
          },
          {
            id: 11,
            event: {
              type: "message.delta",
              scope: { kind: "conversation", id: "conv-prod" },
              payload: {
                messageId: "m-prod",
                conversationId: "conv-prod",
                text: "from prod",
                offset: -5,
                revision: 1.5,
              },
            },
          },
        ],
      }),
    );
    expect(convScopedEvents[0]).toMatchObject({
      conversationId: "conv-prod",
      runId: undefined,
      offset: 0,
      revision: 1,
    });
    expect(convScopedEvents[1]).toMatchObject({
      offset: undefined,
      revision: undefined,
    });
    const prodMap = new Map<string, LiveStreamOverlay>();
    applyLiveStreamBatch(
      prodMap,
      convScopedEvents,
      [{ id: "r-prod", conversation_id: "conv-prod", state: "running" }],
      100,
    );
    expect(prodMap.get("run:r-prod")?.text).toBe("Hello from prod");
    expect(prodMap.get("conv:conv-prod")?.text).toBe("Hello from prod");

    // Starting a new run in the same conversation never inherits the previous run's text
    applyLiveStreamBatch(
      prodMap,
      [
        {
          kind: "state",
          runId: "r-next",
          conversationId: "conv-prod",
          state: "running",
        },
        {
          kind: "delta",
          runId: "r-next",
          conversationId: "conv-prod",
          text: "Fresh turn",
        },
      ],
      [{ id: "r-next", conversation_id: "conv-prod", state: "running" }],
      200,
    );
    expect(prodMap.get("run:r-next")?.text).toBe("Fresh turn");
    expect(prodMap.get("conv:conv-prod")?.text).toBe("Fresh turn");

    // When `activeRuns` lags a new run, `conv:` advances on conversation-scoped deltas;
    // once `activeRuns` catches up, the reducer chooses the further-advanced `conv:` overlay
    // instead of regressing to the older `run:` entry and falsely marking gapped.
    const lagMap = new Map<string, LiveStreamOverlay>();
    applyLiveStreamBatch(
      lagMap,
      [
        {
          kind: "delta",
          runId: "r-lag",
          conversationId: "conv-lag",
          messageId: "m-lag",
          text: "Part 1 ",
          replace: true,
        },
      ],
      [],
      100,
    );
    applyLiveStreamBatch(
      lagMap,
      [
        {
          kind: "delta",
          conversationId: "conv-lag",
          messageId: "m-lag",
          text: "Part 2 ",
          offset: 7,
          revision: 2,
        },
      ],
      [],
      110,
    );
    applyLiveStreamBatch(
      lagMap,
      [
        {
          kind: "delta",
          conversationId: "conv-lag",
          messageId: "m-lag",
          text: "Part 3",
          offset: 14,
          revision: 3,
        },
      ],
      [{ id: "r-lag", conversation_id: "conv-lag", state: "running" }],
      120,
    );
    expect(lagMap.get("run:r-lag")?.gapped).toBe(false);
    expect(lagMap.get("run:r-lag")?.text).toBe("Part 1 Part 2 Part 3");

    // Interleaved assistant messages in the same run (e.g. progress + aggregate answer)
    // keep independent per-message byteEnd cursors and never false-gap each other.
    let multiOv: LiveStreamOverlay | undefined;
    multiOv =
      applyLiveStreamEvent(
        multiOv,
        {
          kind: "delta",
          runId: "r-multi",
          messageId: "m-prog",
          text: "Step 1 ",
          offset: 0,
          revision: 1,
        },
        1,
      ) ?? undefined;
    multiOv =
      applyLiveStreamEvent(
        multiOv,
        {
          kind: "delta",
          runId: "r-multi",
          messageId: "m-ans",
          text: "Answer ",
          offset: 0,
          revision: 1,
        },
        2,
      ) ?? undefined;
    multiOv =
      applyLiveStreamEvent(
        multiOv,
        {
          kind: "delta",
          runId: "r-multi",
          messageId: "m-prog",
          text: "done",
          offset: 7,
          revision: 2,
        },
        3,
      ) ?? undefined;
    expect(multiOv?.gapped).toBe(false);
    expect(multiOv?.text).toBe("Step 1 done");
    multiOv =
      applyLiveStreamEvent(
        multiOv,
        {
          kind: "delta",
          runId: "r-multi",
          messageId: "m-ans",
          text: "complete!",
          offset: 7,
          revision: 2,
        },
        4,
      ) ?? undefined;
    expect(multiOv?.gapped).toBe(false);
    expect(multiOv?.text).toBe("Answer complete!");

    // Brand-new run's offset:0 delta is NOT dropped when activeRuns still lists an older run
    const followUpMap = new Map<string, LiveStreamOverlay>();
    applyLiveStreamBatch(
      followUpMap,
      [
        {
          kind: "delta",
          runId: "r-new-follow",
          conversationId: "conv-x",
          messageId: "m-new",
          text: "Fresh start ",
          offset: 0,
          revision: 1,
        },
      ],
      [{ id: "r-old-active", conversation_id: "conv-x", state: "running" }],
      10,
    );
    expect(followUpMap.get("run:r-new-follow")?.text).toBe("Fresh start ");
    expect(followUpMap.get("run:r-new-follow")?.gapped).toBe(false);

    // Streams past 80,000 chars keep advancing byteEnd, flag `truncated: true`,
    // and retain the opening text instead of replacing a card with only its tail.
    const big = "START" + "a".repeat(80_005);
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
    expect(longOv?.text.startsWith("START")).toBe(true);
    expect(longOv?.truncated).toBe(true);
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
    expect(longOv?.truncated).toBe(true);
    expect(longOv?.text.startsWith("START")).toBe(true);
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
          {
            // Already transitioned to running in activeRuns: must be excluded from queued list
            id: "r-running",
            input: "Stale queued feed row for already-running turn",
            created_at: 50,
            queue_position: 0,
            can_move_up: false,
            can_move_down: false,
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
          kind: "state",
          runId: "r-running",
          conversationId: "conv-open",
          state: "running",
        },
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

    let seq = 0;
    const store = new ActionKeyStore(() => `durable-${++seq}`);
    const pauseScope = store.scopeForRunAction("r1", "pause");
    const cancelScope = store.scopeForRunCancel("r2");
    expect(store.scopeForRunAction("r1", "retry")).toBe("run-retry:r1");
    expect(cancelScope).toBe("run-cancel:r2");
    expect(store.getOrCreate(pauseScope)).toBe("durable-1");
    expect(store.getOrCreate(cancelScope)).toBe("durable-2");
    // While r1 is still running and r2 is still queued, uncertain retries reuse their keys
    store.reconcileRunActions([
      { id: "r1", state: "running" },
      { id: "r2", state: "queued" },
    ]);
    expect(store.getOrCreate(pauseScope)).toBe("durable-1");
    expect(store.getOrCreate(cancelScope)).toBe("durable-2");
    // Once r1 pauses and r2 leaves activeRuns, reconcileRunActions releases both keys
    store.reconcileRunActions([{ id: "r1", state: "paused" }]);
    expect(store.getOrCreate(pauseScope)).toBe("durable-3");
    expect(store.getOrCreate(cancelScope)).toBe("durable-4");
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

describe("mobile persistent drafts and pagination cursors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isolates draft buckets per workspace origin, enforces TTL/size/count caps, and handles prototype keys safely", () => {
    const a = draftWorkspaceBucket("https://alpha.loop.example/");
    const b = draftWorkspaceBucket("https://beta.loop.example");
    const aSame = draftWorkspaceBucket("HTTPS://ALPHA.LOOP.EXAMPLE");
    expect(a).toBe(aSame);
    expect(a).not.toBe(b);
    expect(draftWorkspaceBucket(null)).toBe("demo");

    expect(draftScopeForCarousel("c-1")).toBe("carousel:c-1");
    expect(draftScopeForThread("c-1")).toBe("thread:c-1");
    expect(draftScopeForCompose("a-1")).toBe("compose:agent:a-1");
    expect(draftScopeForCompose(null, "f-9")).toBe("compose:new:f-9");
    expect(draftScopeForCompose(null, null)).toBe("compose:new:root");

    const now = 10_000_000;
    let store = createEmptyDraftMap();
    // Prototype-named scopes cannot collide with Object.prototype
    expect(readDraftFromStore(store, "constructor", now)).toBe("");
    store = setDraftInStore(store, "constructor", "safe text", now);
    store = setDraftInStore(
      store,
      "carousel:c-1",
      "x".repeat(MAX_DRAFT_CHARS + 500),
      now,
    );
    store = setDraftInStore(
      store,
      "thread:old",
      "expired",
      now - DRAFT_TTL_MS - 1,
    );

    const raw = serializeDraftStore(store, now);
    const parsed = parseDraftStore(raw, now);
    expect(readDraftFromStore(parsed, "constructor", now)).toBe("safe text");
    expect(readDraftFromStore(parsed, "carousel:c-1", now).length).toBe(
      MAX_DRAFT_CHARS,
    );
    expect(readDraftFromStore(parsed, "thread:old", now)).toBe("");

    // Pending uncertain-send idempotency key & queue mode survive serialize/parse,
    // and clear automatically when the user edits the draft text.
    const withPending = setDraftInStore(parsed, "thread:c-9", "Retry me", now, {
      key: "retry-key-123456",
      queue: true,
    });
    const reloaded = parseDraftStore(
      serializeDraftStore(withPending, now),
      now,
    );
    expect(readDraftEntryFromStore(reloaded, "thread:c-9", now)).toMatchObject({
      text: "Retry me",
      pendingKey: "retry-key-123456",
      pendingQueue: true,
    });
    const edited = setDraftInStore(
      reloaded,
      "thread:c-9",
      "Retry me edited",
      now + 1,
    );
    expect(
      readDraftEntryFromStore(edited, "thread:c-9", now + 1)?.pendingKey,
    ).toBeUndefined();

    // Whitespace-only text deletes the draft cleanly
    const cleared = setDraftInStore(parsed, "constructor", "   ", now);
    expect(readDraftFromStore(cleared, "constructor", now)).toBe("");
    expect(
      readDraftFromStore(
        deleteDraftFromStore(cleared, "carousel:c-1"),
        "carousel:c-1",
        now,
      ),
    ).toBe("");

    // Count cap retains the newest MAX_DRAFTS_PER_WORKSPACE entries
    let big = createEmptyDraftMap();
    for (let i = 0; i < MAX_DRAFTS_PER_WORKSPACE + 15; i += 1) {
      big = setDraftInStore(big, `carousel:c-${i}`, `draft ${i}`, now + i);
    }
    expect(Object.keys(big)).toHaveLength(MAX_DRAFTS_PER_WORKSPACE);
    expect(readDraftFromStore(big, "carousel:c-0", now + 200)).toBe("");
    expect(
      readDraftFromStore(
        big,
        `carousel:c-${MAX_DRAFTS_PER_WORKSPACE + 14}`,
        now + 200,
      ),
    ).toBe(`draft ${MAX_DRAFTS_PER_WORKSPACE + 14}`);
  });

  it("passes pagination cursors to doneCardsPage, personalFilesPage, search, and conversation", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/v1/cards?view=done&limit=60&before=cur-1",
        text: async () =>
          JSON.stringify({
            revision: "r1",
            items: [],
            next: "cur-2",
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/me/files?before=1700000000",
        text: async () =>
          JSON.stringify({
            items: [],
            next: 1699999000,
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/search?q=deploy&category=done&before=1700000000",
        text: async () =>
          JSON.stringify({
            mode: "lexical",
            items: [],
            next: 1699998000,
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/conversations/conv-1?before=msg-cur-1",
        text: async () =>
          JSON.stringify({
            conversation: {
              id: "conv-1",
              agent_id: "a1",
              title: "Thread",
              project_id: null,
            },
            working: false,
            messages: [],
            next: "msg-cur-2",
            saved: [],
            steerable_run_id: null,
          }),
      } as unknown as Response);

    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-1",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });

    const donePage = await client.doneCardsPage({ before: "cur-1" });
    expect(donePage.next).toBe("cur-2");
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://loop.example.com/api/v1/cards?view=done&limit=60&before=cur-1",
    );

    const filesPage = await client.personalFilesPage({ before: 1700000000 });
    expect(filesPage.next).toBe(1699999000);
    expect(fetchSpy.mock.calls[1][0]).toBe(
      "https://loop.example.com/api/me/files?before=1700000000",
    );

    const searchPage = await client.search("deploy", "done", 1700000000);
    expect(searchPage.next).toBe(1699998000);
    expect(fetchSpy.mock.calls[2][0]).toBe(
      "https://loop.example.com/api/search?q=deploy&category=done&before=1700000000",
    );

    const convPage = await client.conversation("conv-1", "msg-cur-1");
    expect(convPage.next).toBe("msg-cur-2");
    expect(fetchSpy.mock.calls[3][0]).toBe(
      "https://loop.example.com/api/conversations/conv-1?before=msg-cur-1",
    );
  });
});

describe("mobile voice recording and scheduled send helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds valid future schedule presets and validates bounds matching the server window", () => {
    // 10:00 AM local time should include "Later today" (6:00 PM)
    const morning = new Date(2026, 4, 13, 10, 0, 0, 0).getTime();
    const morningPresets = buildSchedulePresets(morning);
    expect(morningPresets.map((p) => p.id)).toEqual([
      "30m",
      "1h",
      "evening",
      "tomorrow",
      "monday",
    ]);
    for (const preset of morningPresets) {
      expect(validateSendAt(preset.sendAt, morning)).toEqual({ ok: true });
    }

    // 7:00 PM local time should omit "Later today" so presets are never in the past
    const evening = new Date(2026, 4, 13, 19, 0, 0, 0).getTime();
    const eveningPresets = buildSchedulePresets(evening);
    expect(eveningPresets.map((p) => p.id)).toEqual([
      "30m",
      "1h",
      "tomorrow",
      "monday",
    ]);
    for (const preset of eveningPresets) {
      expect(validateSendAt(preset.sendAt, evening)).toEqual({ ok: true });
    }

    // Boundary validation
    expect(validateSendAt(morning + MIN_SCHEDULE_LEAD_MS, morning).ok).toBe(
      false,
    );
    expect(validateSendAt(morning + MIN_SCHEDULE_LEAD_MS + 1, morning)).toEqual(
      { ok: true },
    );
    expect(validateSendAt(morning + MAX_SCHEDULE_WINDOW_MS, morning)).toEqual({
      ok: true,
    });
    expect(
      validateSendAt(morning + MAX_SCHEDULE_WINDOW_MS + 1, morning).ok,
    ).toBe(false);
    expect(validateSendAt(Number.NaN, morning).ok).toBe(false);
    expect(validateSendAt(morning + 120_000.5, morning).ok).toBe(false);

    // Custom offsets clamp minimum lead time above server threshold
    expect(validateSendAt(computeCustomSendAt(0, morning), morning)).toEqual({
      ok: true,
    });
    expect(formatScheduledTime(morning + 60 * 60_000, morning)).toMatch(
      /^Today · 11:00 AM$/,
    );
  });

  it("formats voice recording duration and deterministic m4a filenames", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(-5)).toBe("0:00");
    expect(formatVoiceDuration(Number.NaN)).toBe("0:00");
    expect(formatVoiceDuration(7.9)).toBe("0:07");
    expect(formatVoiceDuration(65)).toBe("1:05");
    expect(formatVoiceDuration(125.4)).toBe("2:05");

    const ts = Date.UTC(2026, 10, 27, 8, 5, 9);
    expect(buildVoiceRecordingFilename(ts)).toBe("voice-20261127-080509.m4a");
  });

  it("sends schema-compliant POST /api/scheduled-sends and handles retry outcomes", async () => {
    const sendAt = Date.now() + 3_600_000;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        redirected: false,
        url: "https://loop.example.com/api/scheduled-sends",
        text: async () =>
          JSON.stringify({
            id: "sched-1",
            agent_id: "agent-1",
            conversation_id: "conv-1",
            input: "Check deployment health",
            send_at: sendAt,
            state: "scheduled",
            error: null,
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/scheduled-sends/sched-failed/retry",
        text: async () =>
          JSON.stringify({
            run: null,
            row: {
              id: "sched-failed",
              agent_id: "agent-1",
              conversation_id: null,
              input: "Retry me",
              send_at: sendAt - 7_200_000,
              state: "failed",
              error: "Connect a provider to this agent first",
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        redirected: false,
        url: "https://loop.example.com/api/scheduled-sends/sched-failed/retry",
        text: async () =>
          JSON.stringify({
            run: { id: "run-99", conversation_id: "conv-1", state: "queued" },
            row: {
              id: "sched-failed",
              agent_id: "agent-1",
              conversation_id: "conv-1",
              input: "Retry me",
              send_at: sendAt - 7_200_000,
              state: "submitted",
              error: null,
            },
          }),
      } as unknown as Response);

    const client = new LoopClient({
      origin: "https://loop.example.com",
      cookie: "__Host-loop=tok",
      csrf: "csrf-sched",
      deviceName: "Test iPhone",
      pairedAt: 1,
    });

    const voiceAttachmentId = "11111111-2222-4333-8444-555555555555";
    const created = await client.createScheduledSend({
      agentId: "agent-1",
      conversationId: "conv-1",
      folderId: "folder-1",
      input: "Check deployment health",
      attachmentIds: [voiceAttachmentId],
      replyToMessageId: "msg-1",
      idempotencyKey: "idem-sched-123456",
      sendAt,
    });
    expect(created.id).toBe("sched-1");
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://loop.example.com/api/scheduled-sends",
    );
    const reqInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(reqInit.method).toBe("POST");
    const sentBody = JSON.parse(String(reqInit.body));
    // Prove wire body passes the exact server Zod schema
    expect(ScheduleInput.parse(sentBody)).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      folderId: "folder-1",
      input: "Check deployment health",
      attachmentIds: [voiceAttachmentId],
      replyToMessageId: "msg-1",
      idempotencyKey: "idem-sched-123456",
      sendAt,
    });

    const refused = await client.retryScheduledSend("sched-failed");
    expect(refused.run).toBeNull();
    expect(refused.row.error).toBe("Connect a provider to this agent first");

    const retried = await client.retryScheduledSend("sched-failed");
    expect(retried.run?.id).toBe("run-99");
    expect(retried.row.state).toBe("submitted");
  });

  it("persists and clears uncertain pendingSchedule identities across the 30-day schedule window", () => {
    const now = 1_770_000_000_000;
    const sendAt = now + 20 * 24 * 60 * 60 * 1000; // 20 days out (> 7-day ordinary draft TTL)
    const scope = draftScopeForCarousel("conv-sched-1");
    let store = setDraftInStore(
      createEmptyDraftMap(),
      scope,
      "Follow up tomorrow",
      now,
      {
        schedule: {
          key: "idem-sched-persist-1",
          sendAt,
          input: "Follow up tomorrow",
          agentId: "agent-1",
          folderId: null,
          attachmentIds: ["11111111-2222-4333-8444-555555555555"],
          replyToMessageId: "msg-42",
        },
      },
    );
    // Add 90 ordinary drafts newer than the locked schedule; the locked schedule must not be evicted
    for (let i = 0; i < MAX_DRAFTS_PER_WORKSPACE + 10; i += 1) {
      store = setDraftInStore(
        store,
        draftScopeForThread(`ordinary-${i}`),
        `ordinary ${i}`,
        now + 1000 + i,
      );
    }
    // Check 10 days later (past 7-day ordinary draft TTL, still before sendAt)
    const day10 = now + 10 * 24 * 60 * 60 * 1000;
    const roundTripped = parseDraftStore(
      serializeDraftStore(store, day10),
      day10,
    );
    expect(readDraftEntryFromStore(roundTripped, scope, day10)).toEqual({
      text: "Follow up tomorrow",
      updatedAt: now,
      pendingSchedule: {
        key: "idem-sched-persist-1",
        sendAt,
        input: "Follow up tomorrow",
        agentId: "agent-1",
        folderId: null,
        attachmentIds: ["11111111-2222-4333-8444-555555555555"],
        replyToMessageId: "msg-42",
      },
    });

    // Editing the draft without pending schedule metadata clears the locked schedule identity
    store = setDraftInStore(
      roundTripped,
      scope,
      "Follow up tomorrow with logs",
      day10 + 1000,
    );
    expect(
      readDraftEntryFromStore(store, scope, day10 + 1000)?.pendingSchedule,
    ).toBeUndefined();
  });
});

describe("mobile native Mermaid diagram parser and layout", () => {
  it("parses flowcharts with shapes, subgraphs, labels, cycles, and strips HTML tags", () => {
    const src = `
      %% comment ignored
      flowchart TD
        subgraph API["Edge Layer"]
          A([Start]) --> B{"<b>Valid?</b>"}
        end
        B -->|Yes| C[Process]
        B -. No .-> D((Reject))
        C ==> A
    `;
    const layout = parseMermaidDiagram(src);
    expect(layout?.kind).toBe("flowchart");
    if (!layout || layout.kind !== "flowchart") return;
    expect(layout.direction).toBe("TD");
    expect(layout.nodes.map((n) => n.id)).toEqual(["A", "B", "C", "D"]);
    expect(layout.nodes.find((n) => n.id === "A")?.shape).toBe("stadium");
    expect(layout.nodes.find((n) => n.id === "B")?.shape).toBe("diamond");
    expect(layout.nodes.find((n) => n.id === "B")?.label).toBe("Valid?");
    expect(layout.nodes.find((n) => n.id === "D")?.shape).toBe("circle");
    expect(layout.edges).toHaveLength(4);
    expect(layout.edges[1].label).toBe("Yes");
    expect(layout.edges[2].style).toBe("dashed");
    expect(layout.edges[3].style).toBe("thick");
    expect(layout.subgraphs).toHaveLength(1);
    expect(layout.subgraphs[0].label).toBe("Edge Layer");
    expect(layout.width).toBeGreaterThan(200);
    expect(layout.height).toBeGreaterThan(120);
  });

  it("parses sequence, state, and class diagrams and caps huge inputs", () => {
    const seq = parseMermaidDiagram(`
      sequenceDiagram
        actor U as User
        participant S as Server
        U->>S: POST /api/runs
        Note over U,S: Idempotent key
        S-->>U: 201 Created
        S->>S: Enqueue worker
    `);
    expect(seq?.kind).toBe("sequence");
    if (seq?.kind === "sequence") {
      expect(seq.participants.map((p) => p.label)).toEqual(["User", "Server"]);
      expect(seq.participants[0].isActor).toBe(true);
      expect(seq.steps).toHaveLength(4);
      expect(seq.steps[1].kind).toBe("note");
    }

    const state = parseMermaidDiagram(`
      stateDiagram-v2
        [*] --> Queued
        Queued --> Running : claim
        Running --> [*] : finish
    `);
    expect(state?.kind).toBe("state");
    if (state?.kind === "state") {
      expect(state.nodes.find((n) => n.shape === "start")).toBeTruthy();
      expect(state.nodes.find((n) => n.shape === "end")).toBeTruthy();
      expect(state.edges).toHaveLength(3);
    }

    const cls = parseMermaidDiagram(`
      classDiagram
        class Run {
          +id: string
          +state: string
        }
        Agent *-- Run : owns
    `);
    expect(cls?.kind).toBe("class");
    if (cls?.kind === "class") {
      expect(cls.nodes.find((n) => n.id === "Run")?.members).toEqual([
        "+id: string",
        "+state: string",
      ]);
      expect(cls.edges).toHaveLength(1);
    }

    // Unrecognized syntax returns null so MermaidDiagram falls back to source
    expect(parseMermaidDiagram("gantt\n  title Roadmap")).toBeNull();
    expect(parseMermaidDiagram("")).toBeNull();

    // Quoted & and %% inside node labels must not split nodes or truncate comments
    const quoted = parseMermaidDiagram(`
      flowchart LR
        A["Research & Development (100%%)"] --> B[Done]
    `);
    expect(quoted?.kind).toBe("flowchart");
    if (quoted?.kind === "flowchart") {
      expect(quoted.nodes.map((n) => n.id)).toEqual(["A", "B"]);
      expect(quoted.nodes[0].label).toBe("Research & Development (100%%)");
      expect(quoted.edges).toHaveLength(1);
    }

    // Semicolon-separated statements on one line must not merge across statements
    const multiStmt = parseMermaidDiagram("flowchart LR\n  A --> B; C --> D");
    expect(multiStmt?.kind).toBe("flowchart");
    if (multiStmt?.kind === "flowchart") {
      expect(multiStmt.nodes.map((n) => n.id).sort()).toEqual([
        "A",
        "B",
        "C",
        "D",
      ]);
      expect(multiStmt.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
        "A->B",
        "C->D",
      ]);
    }

    // Sequence diagrams with alt/else/loop branching fall back to source, while participant named Option still parses
    expect(
      parseMermaidDiagram(`
        sequenceDiagram
          A->>B: Request
          alt ok
            B-->>A: 200
          else fail
            B-->>A: 500
          end
      `),
    ).toBeNull();
    expect(
      parseMermaidDiagram(`
        sequenceDiagram
          loop Every minute
            A->>B: Ping
          end
      `),
    ).toBeNull();
    const optParticipant = parseMermaidDiagram(`
      sequenceDiagram
        web-app->>API: Select
        API-xweb-app: Timeout
        Option->API: Open
    `);
    expect(optParticipant?.kind).toBe("sequence");
    if (optParticipant?.kind === "sequence") {
      expect(
        optParticipant.steps.map((s) => (s.kind === "message" ? s.head : "")),
      ).toEqual(["arrow", "cross", "none"]);
      expect(optParticipant.participants.map((p) => p.id)).toEqual([
        "web-app",
        "API",
        "Option",
      ]);
    }

    // Apostrophes inside labels, --x connectors, class composition/cardinality, and composite state fallback
    const apostrophe = parseMermaidDiagram(
      "flowchart LR\n  A[Don't panic] --x B[Done]",
    );
    expect(apostrophe?.kind).toBe("flowchart");
    if (apostrophe?.kind === "flowchart") {
      expect(apostrophe.nodes.map((n) => n.label)).toEqual([
        "Don't panic",
        "Done",
      ]);
      expect(apostrophe.edges[0].markerEnd).toBe("cross");
    }

    const uml = parseMermaidDiagram(
      'classDiagram\n  Owner "1" *-- "*" Part\n  Impl <|.. Iface\n  A "1" -- B\n  C -- "1" D',
    );
    expect(uml?.kind).toBe("class");
    if (uml?.kind === "class") {
      expect(uml.edges[0].markerStart).toBe("diamond");
      expect(uml.edges[0].label).toBe("1..*");
      expect(uml.edges[1].markerStart).toBe("triangle");
      expect(uml.edges[1].style).toBe("dashed");
      expect(uml.edges[2].label).toBe("1..");
      expect(uml.edges[3].label).toBe("..1");
    }

    // State diagram [*] sentinel never collides with a user state named __start__
    const stateSentinel = parseMermaidDiagram(
      "stateDiagram-v2\n  [*] --> __start__\n  __start__ --> Ready",
    );
    expect(stateSentinel?.kind).toBe("state");
    if (stateSentinel?.kind === "state") {
      expect(stateSentinel.nodes).toHaveLength(3);
      expect(stateSentinel.edges[0].from).not.toBe(stateSentinel.edges[0].to);
    }

    expect(
      parseMermaidDiagram(
        "stateDiagram-v2\n  state Active {\n    [*] --> Inner\n  }",
      ),
    ).toBeNull();

    // Hyphenated directive-prefixed IDs and inline labels with hyphens/dots still parse cleanly
    const hyphenated = parseMermaidDiagram(
      "flowchart LR\n  style-check -- pre-flight --> Deploy\n  Deploy -. v1.2 .-> Done",
    );
    expect(hyphenated?.kind).toBe("flowchart");
    if (hyphenated?.kind === "flowchart") {
      expect(hyphenated.nodes.map((n) => n.id)).toEqual([
        "style-check",
        "Deploy",
        "Done",
      ]);
      expect(hyphenated.edges.map((e) => e.label)).toEqual([
        "pre-flight",
        "v1.2",
      ]);
    }

    // Adversarial ReDoS & repeated & fan-out inputs must complete quickly without blowing up
    const t0 = Date.now();
    parseMermaidDiagram(`flowchart TD\n  A ${"-- ".repeat(10_000)} x`);
    parseMermaidDiagram(`flowchart TD\n  A ${"-. ".repeat(10_000)} x`);
    parseMermaidDiagram(`flowchart TD\n  A -- ${" ".repeat(30_000)} x`);
    parseMermaidDiagram(`flowchart TD\n  A["${"<".repeat(30_000)}"] --> B`);
    parseMermaidDiagram(`classDiagram\n  ${"-".repeat(30_000)}!`);
    parseMermaidDiagram(`sequenceDiagram\n  ${"a->".repeat(10_000)}`);
    parseMermaidDiagram(`sequenceDiagram\n  Note over ${" ".repeat(30_000)} x`);
    parseMermaidDiagram(`${"%%{".repeat(5_000)}flowchart TD\nA-->B`);
    const dedupFan = parseMermaidDiagram(
      `flowchart LR\n  ${Array(500).fill("A").join("&")} --> ${Array(500).fill("B").join("&")}`,
    );
    expect(dedupFan?.kind).toBe("flowchart");
    if (dedupFan?.kind === "flowchart") {
      expect(dedupFan.edges).toHaveLength(1);
    }
    expect(Date.now() - t0).toBeLessThan(2000);

    // Oversized graphs return null so MermaidDiagram falls back to full source instead of truncating silently
    const hugeLines = ["graph LR"];
    for (let i = 0; i < MAX_MERMAID_NODES + 25; i += 1) {
      hugeLines.push(`N${i} --> N${i + 1}`);
    }
    expect(parseMermaidDiagram(hugeLines.join("\n"))).toBeNull();

    const manySubgraphs = ["flowchart TD"];
    for (let i = 0; i < 40; i += 1) {
      manySubgraphs.push(`subgraph S${i}\n  N${i}\nend`);
    }
    expect(parseMermaidDiagram(manySubgraphs.join("\n"))).toBeNull();
  });
});

describe("mobile native LaTeX math parser and currency safety", () => {
  it("detects inline math while refusing currency amounts in prose", () => {
    expect(findInlineMathAt("Cost is $5 and $10 today.", 8)).toBeNull();
    expect(findInlineMathAt("Price $100/mo to $200/mo.", 6)).toBeNull();
    expect(findInlineMathAt("Bad $ x + 1 $ spacing", 4)).toBeNull();
    expect(findInlineMathAt("Escaped \\$x$ text", 9)).toBeNull();
    expect(
      findInlineMathAt("Set $NAME first, then run `X=$VALUE`", 4),
    ).toBeNull();
    expect(findInlineMathAt("export PATH=$PATH:$HOME/bin", 12)).toBeNull();
    expect(findInlineMathAt("See $ref/$id for details", 4)).toBeNull();
    expect(findInlineMathAt("Path ${A}/${B}", 5)).toBeNull();
    expect(findInlineMathAt("Run $(pwd)/$(whoami) now", 4)).toBeNull();

    expect(findInlineMathAt("Given $x^2 + y^2 = r^2$, we have", 6)).toEqual({
      raw: "x^2 + y^2 = r^2",
      end: 23,
    });
    expect(findInlineMathAt("Let \\(\\alpha + \\beta\\) hold.", 4)).toEqual({
      raw: "\\alpha + \\beta",
      end: 22,
    });
  });

  it("formats inline LaTeX typography and parses display fractions, matrices, and prototype-safe envs", () => {
    expect(formatLatexInline("x^2 + y_1 \\le \\infty")).toBe("x² + y₁ ≤ ∞");
    expect(formatLatexInline("\\alpha \\to \\beta \\in \\mathbb{R}")).toBe(
      "α → β ∈ ℝ",
    );
    expect(formatLatexInline("\\sqrt[3]{x + 1}")).toBe("³√(x + 1)");
    expect(formatLatexInline("\\sqrt{x}")).toBe("√x");
    expect(formatLatexInline("\\sqrt{ab}")).toBe("√(ab)");
    expect(formatLatexInline("\\frac{a + b}{c}")).toBe("(a + b)/c");
    expect(formatLatexInline("\\frac{1}{2x}")).toBe("1/(2x)");
    expect(formatLatexInline("\\frac{a}{\\frac{b}{c}}")).toBe("a/(b/c)");

    // Prototype keys as environment names must never crash
    expect(formatLatexInline("\\begin{constructor}x\\end{constructor}")).toBe(
      "x",
    );
    expect(
      parseLatexDisplayRows("\\begin{toString}1 & 2\\end{toString}"),
    ).toEqual([[{ kind: "matrix", left: "", right: "", rows: [["1", "2"]] }]]);

    // Fractions nested inside braces stay attached to their exponent instead of splitting out
    expect(parseLatexDisplayRows("x^{\\frac{1}{2}} + 1")).toEqual([
      [{ kind: "text", text: "x^(1/2) + 1" }],
    ]);

    const fracRows = parseLatexDisplayRows(
      "E = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    );
    expect(fracRows).toEqual([
      [
        { kind: "text", text: "E =" },
        { kind: "fraction", num: "-b ± √(b² - 4ac)", den: "2a" },
      ],
    ]);

    const matRows = parseLatexDisplayRows(
      "A = \\begin{bmatrix} \\text{R\\&D} & 2 \\\\ 3 & 4 \\end{bmatrix}",
    );
    expect(matRows).toEqual([
      [
        { kind: "text", text: "A =" },
        {
          kind: "matrix",
          left: "[",
          right: "]",
          rows: [
            ["R&D", "2"],
            ["3", "4"],
          ],
        },
      ],
    ]);

    // Nested matrices keep inner \\ and & inside the inner environment
    const nestedMat = parseLatexDisplayRows(
      "\\begin{bmatrix}\\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix} & 5\\end{bmatrix}",
    );
    expect(nestedMat).toEqual([
      [
        {
          kind: "matrix",
          left: "[",
          right: "]",
          rows: [["(1, 2; 3, 4)", "5"]],
        },
      ],
    ]);
  });
});

describe("mobile native notification diffing, preferences, and workspace isolation", () => {
  it("never notifies on initial baseline load, respects per-kind toggles, and caps bursts", () => {
    const baseCard: NativeResultCard = {
      id: "card-1",
      conversationId: "conv-1",
      tab: "done",
      agentId: "agent-1",
      agentName: "willow",
      projectName: "Loop",
      model: "claude-sonnet-4",
      prompt: "Check CI",
      fallbackTitle: "CI Summary",
      body: "All green",
      createdAt: 1000,
      saved: false,
      unread: true,
      doneUnread: true,
      messageId: "msg-1",
    };

    // Baseline (previous === null) must emit zero events so cold start / cache hydration never spam
    const baseline = detectNotificationEvents(
      null,
      {
        approvals: [
          {
            id: "app-0",
            run_id: "r0",
            conversation_id: "conv-0",
            agent_id: "a1",
            agent_name: "willow",
            tool_name: "bash",
            state: "pending",
            created_at: 900,
          },
        ],
        decisions: [],
        cards: [baseCard],
      },
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(baseline.events).toEqual([]);

    // Newly arrived approval, decision, completed result, and reply fire only enabled kinds
    const nextState = {
      approvals: [
        {
          id: "app-0",
          run_id: "r0",
          conversation_id: "conv-0",
          agent_id: "a1",
          agent_name: "willow",
          tool_name: "bash",
          state: "pending",
          created_at: 900,
        },
        {
          id: "app-1",
          run_id: "r1",
          conversation_id: "conv-1",
          agent_id: "a1",
          agent_name: "willow",
          tool_name: "git_push",
          summary: "Push release tag",
          state: "pending",
          created_at: 1100,
        },
      ],
      decisions: [
        {
          id: "dec-1",
          run_id: "r2",
          conversation_id: "conv-2",
          title: "Pick strategy",
          question: "Merge or rebase?",
          state: "pending",
          created_at: 1150,
        },
      ],
      cards: [
        baseCard,
        {
          ...baseCard,
          id: "card-2",
          conversationId: "conv-3",
          messageId: "msg-2",
          fallbackTitle: "Benchmarks ready",
          doneUnread: true,
          unread: true,
        },
        {
          ...baseCard,
          id: "card-3",
          conversationId: "conv-4",
          messageId: "msg-3",
          agentName: "cedar",
          body: "Ready for review",
          doneUnread: false,
          replyUnread: true,
          unread: true,
        },
      ],
    };

    const allEnabled = detectNotificationEvents(
      baseline.nextSnapshot,
      nextState,
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(allEnabled.events.map((e) => e.kind)).toEqual([
      "approval",
      "decision",
      "reply",
      "completed",
    ]);

    // Master switch off suppresses all events while still advancing snapshot
    const muted = detectNotificationEvents(baseline.nextSnapshot, nextState, {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: false,
    });
    expect(muted.events).toEqual([]);

    // Selective preferences filter out disabled categories
    const onlyNeeds = detectNotificationEvents(
      baseline.nextSnapshot,
      nextState,
      { enabled: true, needsYou: true, completed: false, replies: false },
    );
    expect(onlyNeeds.events.map((e) => e.kind)).toEqual([
      "approval",
      "decision",
    ]);

    // Burst cap prevents notification storms after returning online
    const manyApprovals = Array.from({ length: 12 }, (_, idx) => ({
      id: `burst-${idx}`,
      run_id: `r-${idx}`,
      conversation_id: `c-${idx}`,
      agent_id: "a1",
      agent_name: "willow",
      tool_name: "bash",
      state: "pending",
      created_at: 2000 + idx,
    }));
    const burst = detectNotificationEvents(
      baseline.nextSnapshot,
      { approvals: manyApprovals, decisions: [], cards: [] },
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(burst.events).toHaveLength(MAX_NOTIFICATION_BURST);

    // Transient sub-fetch failures (null approvals/decisions or repliesLoaded: false)
    // must preserve the previous snapshot so the next healthy refresh does not re-alert.
    const transientFailure = detectNotificationEvents(
      allEnabled.nextSnapshot,
      {
        approvals: null,
        decisions: null,
        cards: [baseCard, nextState.cards[1]],
        repliesLoaded: false,
      },
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(transientFailure.events).toEqual([]);
    const recovered = detectNotificationEvents(
      transientFailure.nextSnapshot,
      nextState,
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(recovered.events).toEqual([]);

    // Partial first load (approvals/decisions/replies failed on initial load) must
    // establish silent baselines when those categories later recover, without spamming.
    const partialFirst = detectNotificationEvents(
      null,
      {
        approvals: null,
        decisions: null,
        cards: [baseCard],
        repliesLoaded: false,
      },
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(partialFirst.events).toEqual([]);
    const recoveredAfterPartialFirst = detectNotificationEvents(
      partialFirst.nextSnapshot,
      {
        approvals: nextState.approvals,
        decisions: nextState.decisions,
        cards: [baseCard, nextState.cards[2]],
        repliesLoaded: true,
      },
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(recoveredAfterPartialFirst.events).toEqual([]);
  });

  it("round-trips notification prefs safely and isolates notification tap targets by workspace bucket", () => {
    const saved = serializeNotificationPrefs({
      enabled: true,
      needsYou: true,
      completed: false,
      replies: true,
    });
    expect(parseNotificationPrefs(saved)).toEqual({
      enabled: true,
      needsYou: true,
      completed: false,
      replies: true,
    });
    expect(parseNotificationPrefs("{bad json")).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );

    const bucketA = draftWorkspaceBucket("https://alpha.loop.example");
    const bucketB = draftWorkspaceBucket("https://beta.loop.example");
    const tapData = {
      originBucket: bucketA,
      conversationId: "conv-alpha-1",
      title: "Approval needed",
      agentName: "willow",
    };
    expect(parseNotificationTapTarget(tapData, bucketA)).toEqual({
      conversationId: "conv-alpha-1",
      title: "Approval needed",
      agentName: "willow",
    });
    // Tapping an alert from workspace A while signed into workspace B must be rejected
    expect(parseNotificationTapTarget(tapData, bucketB)).toBeNull();
    expect(
      parseNotificationTapTarget({ originBucket: bucketA }, bucketA),
    ).toBeNull();
  });
});

describe("mobile incoming share normalization and server contract compatibility", () => {
  it("normalizes links, text, and files while rejecting unsafe URLs and matching server Zod schemas", async () => {
    expect(isSafeHttpUrl("https://example.com/article?id=1")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("https://user:pass@example.com/secret")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);

    const normalized = normalizeIncomingSharePayloads([
      { shareType: "url", value: "javascript:alert(1)" },
      { shareType: "url", value: "https://docs.example.com/spec" },
      { shareType: "text", value: "Key excerpt from section 2" },
    ]);
    expect(normalized).not.toBeNull();
    expect(normalized?.sourceUrl).toBe("https://docs.example.com/spec");
    expect(normalized?.sourceTitle).toBe("docs.example.com");
    expect(normalized?.sharedText).toBe("Key excerpt from section 2");
    expect(normalized?.files).toEqual([]);

    const sendBody = buildShareSendPayload({
      question: "Summarize the trade-offs",
      share: normalized!,
      folderId: "folder-1",
      agentId: "agent-1",
      idempotencyKey: "share-idem-key-123456",
    });
    expect(sendBody).not.toBeNull();
    // Validate exact wire shape against production server Zod schemas
    expect(() => ShareSendInput.parse(sendBody)).not.toThrow();
    expect(() =>
      ShareInput.parse({
        question: sendBody!.question,
        source: sendBody!.source,
        folderId: sendBody!.folderId,
      }),
    ).not.toThrow();

    // Verify LoopClient.sharePreview and LoopClient.shareSend wire payloads
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (path === "/api/share/preview") {
        ShareInput.parse(body);
        return new Response(
          JSON.stringify({
            mode: "queue",
            agent: {
              id: "agent-1",
              name: "willow",
              provider: "anthropic",
              model: "claude-sonnet-4",
              effort: null,
            },
            source: body.source,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      ShareSendInput.parse(body);
      return new Response(
        JSON.stringify({ id: "run-share-1", conversation_id: "conv-share-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LoopClient({
      origin: "https://loop.example",
      cookie: "loop_session=abc",
      csrf: "csrf-token",
      deviceName: "Test iPhone",
      pairedAt: Date.now(),
    });
    const preview = await client.sharePreview({
      question: "@willow summarize this",
      source: sendBody!.source,
    });
    expect(preview.mode).toBe("queue");
    expect(preview.agent?.name).toBe("willow");
    const sent = await client.shareSend(sendBody!);
    expect(sent).toEqual({
      id: "run-share-1",
      conversation_id: "conv-share-1",
    });

    // File share normalization routes through ShareSendInput with attachmentIds
    const fileShare = normalizeIncomingSharePayloads([
      {
        shareType: "image",
        value: "file:///cache/photo.png",
        contentUri: "file:///cache/photo.png",
        contentMimeType: "image/png",
        originalName: "diagram.png",
        contentSize: 2048,
      },
      { shareType: "text", value: "What changed here?" },
    ]);
    expect(fileShare?.files).toEqual([
      {
        uri: "file:///cache/photo.png",
        name: "diagram.png",
        mimeType: "image/png",
        size: 2048,
      },
    ]);
    const fileSendBody = buildShareSendPayload({
      question: "@willow inspect this screenshot",
      share: fileShare!,
      agentId: "agent-1",
      attachmentIds: ["11111111-2222-4333-8444-555555555555"],
      idempotencyKey: "share-file-idem-123456",
    });
    expect(fileSendBody).not.toBeNull();
    expect(() => ShareSendInput.parse(fileSendBody)).not.toThrow();
    expect(extractLeadingShareHandle("@Willow, check this")).toBe("willow");
    expect(extractLeadingShareHandle("Summarize this")).toBeNull();

    // Share fingerprint is case-sensitive and delimiter-safe (no pipe-concatenation collisions)
    const upperShare = normalizeIncomingSharePayloads([
      { shareType: "text", value: "Review README" },
    ]);
    const lowerShare = normalizeIncomingSharePayloads([
      { shareType: "text", value: "review readme" },
    ]);
    expect(upperShare?.fingerprint).not.toBe(lowerShare?.fingerprint);

    const pipeA = normalizeIncomingSharePayloads([
      { shareType: "url", value: "https://example.com/a|b" },
      { shareType: "text", value: "c" },
    ]);
    const pipeB = normalizeIncomingSharePayloads([
      { shareType: "url", value: "https://example.com/a" },
      { shareType: "text", value: "b|c" },
    ]);
    expect(pipeA?.fingerprint).not.toBe(pipeB?.fingerprint);

    // Re-sharing the same file across different OS temp cache URIs produces the same fingerprint
    const fileShareSecondUri = normalizeIncomingSharePayloads([
      {
        shareType: "image",
        value: "file:///cache/run-2/photo.png",
        contentUri: "file:///cache/run-2/photo.png",
        contentMimeType: "image/png",
        originalName: "diagram.png",
        contentSize: 2048,
      },
      { shareType: "text", value: "What changed here?" },
    ]);
    expect(fileShareSecondUri?.fingerprint).toBe(fileShare?.fingerprint);

    // Local-only file URI validation blocks remote URLs, path traversal, and internal Loop cache files
    expect(isSafeLocalShareFileUri("file:///cache/doc.pdf")).toBe(true);
    expect(isSafeLocalShareFileUri("content://media/external/images/1")).toBe(
      true,
    );
    expect(isSafeLocalShareFileUri("https://evil.example/payload.bin")).toBe(
      false,
    );
    expect(isSafeLocalShareFileUri("file:///cache/../secrets.json")).toBe(
      false,
    );
    expect(
      isSafeLocalShareFileUri("file:///cache/loop-cache-ws_1234.json"),
    ).toBe(false);
    expect(
      normalizeIncomingSharePayloads([
        { shareType: "file", value: "https://evil.example/payload.bin" },
      ]),
    ).toBeNull();

    // Retry failure classification never clears/rotates on uncertain outcomes, idempotency 409s,
    // or rejected retries of an earlier uncertain send, while clearing fresh definite rejections
    expect(
      classifyShareSendFailure({
        wasRetry: false,
        isUncertain: false,
        status: 409,
        message: "This agent is retired.",
      }),
    ).toBe("clear-and-rotate");
    expect(
      classifyShareSendFailure({
        wasRetry: false,
        isUncertain: false,
        status: 409,
        message: "This request key belongs to different work",
      }),
    ).toBe("keep-lock-conflict");
    expect(
      classifyShareSendFailure({
        wasRetry: true,
        isUncertain: false,
        status: 409,
        message: "This agent is retired.",
      }),
    ).toBe("keep-lock-retry-rejected");
    expect(
      classifyShareSendFailure({
        wasRetry: true,
        isUncertain: false,
        status: 404,
        message: "That @handle is unknown",
      }),
    ).toBe("keep-lock-retry-rejected");
    expect(
      classifyShareSendFailure({
        wasRetry: false,
        isUncertain: true,
        status: 504,
      }),
    ).toBe("keep-lock-uncertain");

    // Durable pendingShare metadata (key, agentId, folderId, attachmentIds) survives serialization
    // and is protected ahead of the 80-draft cap for uncertain retry recovery
    const shareScope = draftScopeForShare(upperShare!.fingerprint);
    const now = 1_780_000_000_000;
    let draftMap = setDraftInStore(
      createEmptyDraftMap(),
      shareScope,
      "Inspect README",
      now,
      {
        share: {
          key: "share-retry-key-123456",
          agentId: "agent-1",
          folderId: "folder-9",
          attachmentIds: ["11111111-2222-4333-8444-555555555555"],
        },
      },
    );
    for (let i = 0; i < MAX_DRAFTS_PER_WORKSPACE + 5; i += 1) {
      draftMap = setDraftInStore(
        draftMap,
        draftScopeForThread(`conv-${i}`),
        `ordinary draft ${i}`,
        now + 1000 + i,
      );
    }
    const restored = parseDraftStore(
      serializeDraftStore(draftMap, now + DRAFT_TTL_MS * 3),
      now + DRAFT_TTL_MS * 3,
    );
    expect(
      readDraftEntryFromStore(restored, shareScope, now + DRAFT_TTL_MS * 3)
        ?.pendingShare,
    ).toEqual({
      key: "share-retry-key-123456",
      agentId: "agent-1",
      folderId: "folder-9",
      attachmentIds: ["11111111-2222-4333-8444-555555555555"],
    });
  });
});

describe("mobile offline workspace cache codec", () => {
  it("round-trips allowlisted display state, strips sensitive/host fields, and enforces TTL and caps", () => {
    const now = 1_780_000_000_000;
    const rawJson = serializeWorkspaceCache(
      {
        environmentName: "Studio Mac",
        cards: [
          {
            id: "c-1",
            conversationId: "conv-1",
            tab: "done",
            agentId: "a-1",
            agentName: "willow",
            projectName: "Loop",
            model: "claude-sonnet-4",
            prompt: "Review PR",
            fallbackTitle: "PR Review",
            body: "x".repeat(MAX_CACHED_CARD_BODY_CHARS + 500),
            createdAt: now - 5000,
            saved: true,
            unread: false,
            // Extra unexpected field simulating accidental secret attachment
            ...({ cookie: "secret-cookie", csrf: "secret-csrf" } as Record<
              string,
              unknown
            >),
          },
        ],
        agents: [
          {
            id: "a-1",
            name: "willow",
            provider: "anthropic",
            connection_id: "conn-1",
            model: "claude-sonnet-4",
            instructions: "PRIVATE SYSTEM PROMPT SHOULD NOT BE CACHED",
          },
        ],
        folders: [
          {
            id: "f-1",
            name: "Loop",
            parent_id: null,
            kind: "project",
            path: "/Users/owner/private/loop",
          },
        ],
        summary: {
          needs: 1,
          working: 0,
          queued: 2,
          later_due: 0,
          done_unread: 3,
        },
      },
      now,
    );

    // Serialized payload must never contain cookies, CSRF, instructions, or host paths
    expect(rawJson).not.toContain("secret-cookie");
    expect(rawJson).not.toContain("secret-csrf");
    expect(rawJson).not.toContain("PRIVATE SYSTEM PROMPT");
    expect(rawJson).not.toContain("/Users/owner/private");

    const hydrated = parseWorkspaceCache(rawJson, now + 60_000);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.environmentName).toBe("Studio Mac");
    expect(hydrated?.cards).toHaveLength(1);
    expect(hydrated?.cards[0].body).toHaveLength(MAX_CACHED_CARD_BODY_CHARS);
    expect(hydrated?.cards[0].bodyTruncated).toBe(true);
    expect(hydrated?.agents[0].instructions).toBe("");
    expect(hydrated?.folders[0].path).toBeUndefined();
    expect(hydrated?.summary?.done_unread).toBe(3);

    // Expired cache (> 24h TTL) or far-future clock skew returns null
    expect(
      parseWorkspaceCache(rawJson, now + OFFLINE_CACHE_TTL_MS + 1),
    ).toBeNull();
    expect(parseWorkspaceCache(rawJson, now - 120_000)).toBeNull();

    // Card and agent counts are capped
    const manyCards = Array.from({ length: MAX_CACHED_CARDS + 15 }, (_, i) => ({
      id: `c-${i}`,
      conversationId: `conv-${i}`,
      tab: "done" as const,
      agentName: "willow",
      projectName: "Loop",
      model: "claude",
      prompt: "p",
      fallbackTitle: "t",
      body: "b",
      createdAt: now,
      saved: false,
      unread: false,
    }));
    const manyAgents = Array.from(
      { length: MAX_CACHED_AGENTS + 10 },
      (_, i) => ({
        id: `a-${i}`,
        name: `agent-${i}`,
        provider: "anthropic",
        connection_id: null,
        model: "claude",
        instructions: "",
      }),
    );
    const capped = parseWorkspaceCache(
      serializeWorkspaceCache(
        {
          environmentName: "Big",
          cards: manyCards,
          agents: manyAgents,
          folders: [],
          summary: null,
        },
        now,
      ),
      now,
    );
    expect(capped?.cards).toHaveLength(MAX_CACHED_CARDS);
    expect(capped?.agents).toHaveLength(MAX_CACHED_AGENTS);
  });
});

describe("mobile text selection helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires success feedback only after clipboard write resolves and resets after delay", async () => {
    vi.useFakeTimers();
    const tracker = new CopySessionTracker();
    let resolveWrite!: () => void;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });

    const onSuccess = vi.fn();
    const onReset = vi.fn();
    const onError = vi.fn();

    const pending = tracker.copy(() => writePromise, {
      onSuccess,
      onReset,
      onError,
      resetDelayMs: 1600,
    });

    // Must not trigger success haptic/state before clipboard write settles;
    // starting a copy resets any prior copied state up front
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledTimes(1);

    resolveWrite();
    await expect(pending).resolves.toBe(true);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onReset).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1599);
    expect(onReset).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("fires error callback and suppresses success feedback when clipboard write rejects", async () => {
    vi.useFakeTimers();
    const tracker = new CopySessionTracker();
    const onSuccess = vi.fn();
    const onReset = vi.fn();
    const onError = vi.fn();

    const ok = await tracker.copy(
      () => Promise.reject(new Error("clipboard denied")),
      { onSuccess, onReset, onError },
    );

    expect(ok).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    // Only the initial pre-copy reset ran; no reset timer was scheduled
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("ignores late clipboard resolution or rejection after close/switch or overlapping copy", async () => {
    vi.useFakeTimers();
    const tracker = new CopySessionTracker();
    let resolveFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const firstSuccess = vi.fn();
    const firstReset = vi.fn();
    const firstPending = tracker.copy(() => firstWrite, {
      onSuccess: firstSuccess,
      onReset: firstReset,
    });

    // Modal closes (or switches to another message) before write settles
    tracker.invalidate();

    resolveFirst();
    await expect(firstPending).resolves.toBe(false);
    expect(firstSuccess).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(firstReset).toHaveBeenCalledTimes(1);

    // Overlapping copy supersedes an earlier in-flight write even if the earlier write later rejects
    let rejectFirstCopy!: (err: Error) => void;
    const slowFirstCopy = new Promise<void>((_, reject) => {
      rejectFirstCopy = reject;
    });
    const staleSuccess = vi.fn();
    const staleError = vi.fn();
    const latestSuccess = vi.fn();
    const latestReset = vi.fn();

    const firstAttempt = tracker.copy(() => slowFirstCopy, {
      onSuccess: staleSuccess,
      onReset: vi.fn(),
      onError: staleError,
    });
    const secondAttempt = tracker.copy(() => Promise.resolve(), {
      onSuccess: latestSuccess,
      onReset: latestReset,
    });

    await expect(secondAttempt).resolves.toBe(true);
    rejectFirstCopy(new Error("stale rejection"));
    await expect(firstAttempt).resolves.toBe(false);
    expect(staleSuccess).not.toHaveBeenCalled();
    expect(staleError).not.toHaveBeenCalled();
    expect(latestSuccess).toHaveBeenCalledTimes(1);
  });

  it("clears a prior copied badge immediately when a subsequent copy is slow or rejects", async () => {
    vi.useFakeTimers();
    const tracker = new CopySessionTracker();
    let copiedId: string | null = null;
    const onError = vi.fn();

    // First copy succeeds and sets badge to msg-a
    await expect(
      tracker.copy(() => Promise.resolve(), {
        onSuccess: () => {
          copiedId = "msg-a";
        },
        onReset: () => {
          copiedId = null;
        },
        onError,
      }),
    ).resolves.toBe(true);
    expect(copiedId).toBe("msg-a");

    // Within 1.6s, copy msg-b starts with a slow/failing clipboard write
    let rejectMsgB!: (err: Error) => void;
    const msgBWrite = new Promise<void>((_, reject) => {
      rejectMsgB = reject;
    });
    const pendingB = tracker.copy(() => msgBWrite, {
      onSuccess: () => {
        copiedId = "msg-b";
      },
      onReset: () => {
        copiedId = null;
      },
      onError,
    });

    // Prior badge must clear immediately while msg-b is in flight
    expect(copiedId).toBeNull();

    // Rejecting msg-b must keep copiedId cleared and fire onError once
    rejectMsgB(new Error("clipboard unavailable"));
    await expect(pendingB).resolves.toBe(false);
    expect(copiedId).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("detects interactive URL and Loop file links including nested formatting", () => {
    expect(
      hasInteractiveInlineLink([{ kind: "text", text: "plain text" }]),
    ).toBe(false);
    expect(
      hasInteractiveInlineLink([
        {
          kind: "link",
          url: "file:///Users/owner/readme.md",
          isLocalFile: true,
        },
      ]),
    ).toBe(false);
    expect(
      hasInteractiveInlineLink([
        { kind: "link", url: "https://example.com/docs" },
      ]),
    ).toBe(true);
    expect(
      hasInteractiveInlineLink(
        [
          {
            kind: "bold",
            children: [
              {
                kind: "link",
                url: "/api/artifacts/12345678-1234-1234-1234-1234567890ab/file",
              },
            ],
          },
        ],
        "https://loop.local",
      ),
    ).toBe(true);
    // Without an onOpenFile handler (e.g. FilePreviewModal), relative Loop file links are non-interactive
    expect(
      hasInteractiveInlineLink(
        [
          {
            kind: "link",
            url: "/api/artifacts/12345678-1234-1234-1234-1234567890ab/file",
          },
        ],
        "https://loop.local",
        false,
      ),
    ).toBe(false);
  });

  it("disables inline selectable only on Android paragraphs with interactive links", () => {
    expect(
      resolveInlineTextSelectable({
        selectable: false,
        platformOs: "ios",
        hasInteractiveLinks: false,
      }),
    ).toBe(false);
    expect(
      resolveInlineTextSelectable({
        selectable: true,
        platformOs: "ios",
        hasInteractiveLinks: true,
      }),
    ).toBe(true);
    expect(
      resolveInlineTextSelectable({
        selectable: true,
        platformOs: "android",
        hasInteractiveLinks: false,
      }),
    ).toBe(true);
    expect(
      resolveInlineTextSelectable({
        selectable: true,
        platformOs: "android",
        hasInteractiveLinks: true,
      }),
    ).toBe(false);
  });

  it("shows FilePreviewModal Select text toggle only where it changes the rendered view", () => {
    expect(
      shouldShowPreviewSelectToggle({
        hasTextContent: false,
        isMarkdown: true,
        platformOs: "ios",
      }),
    ).toBe(false);
    expect(
      shouldShowPreviewSelectToggle({
        hasTextContent: true,
        isMarkdown: false,
        platformOs: "ios",
      }),
    ).toBe(true);
    expect(
      shouldShowPreviewSelectToggle({
        hasTextContent: true,
        isMarkdown: true,
        platformOs: "android",
      }),
    ).toBe(true);
    // Plain-text previews on Android already render a single selectable <Text>
    expect(
      shouldShowPreviewSelectToggle({
        hasTextContent: true,
        isMarkdown: false,
        platformOs: "android",
      }),
    ).toBe(false);
  });

  it("preserves selectable defaults and wiring across mobile thread and rich-content components", () => {
    const mobileDir = path.resolve("apps/mobile/src/components");
    const rich = readFileSync(path.join(mobileDir, "RichContent.tsx"), "utf8");
    const mermaid = readFileSync(
      path.join(mobileDir, "MermaidDiagram.tsx"),
      "utf8",
    );
    const thread = readFileSync(
      path.join(mobileDir, "ThreadSheet.tsx"),
      "utf8",
    );
    const preview = readFileSync(
      path.join(mobileDir, "FilePreviewModal.tsx"),
      "utf8",
    );

    // RichContent and MermaidDiagram keep selectable=false by default for card/carousel callers
    expect(rich).toMatch(/function RichContent[\s\S]*?selectable = false/);
    expect(rich).toMatch(
      /export function InlineFormattedText[\s\S]*?selectable = false/,
    );
    expect(mermaid).toMatch(
      /export function MermaidDiagram[\s\S]*?selectable = false/,
    );
    // Chart title, category labels, and numbers propagate selectable
    expect(rich).toContain("resolveInlineTextSelectable");
    expect(rich).toMatch(
      /NativeSpecChart[\s\S]*?selectable=\{selectable\}[\s\S]*?specCardTitle/,
    );
    expect(rich).toMatch(
      /NativeSpecChart[\s\S]*?selectable=\{selectable\}[\s\S]*?chartLabelText/,
    );
    // ThreadSheet keeps live stream non-selectable inline while offering the Select text snapshot sheet
    expect(thread).toMatch(
      /content=\{liveStream\.text\}[\s\S]*?selectable=\{false\}/,
    );
    expect(thread).toContain("new CopySessionTracker()");
    // FilePreviewModal offers in-place selectable text toggle without nested Modal
    expect(preview).toContain("selectTextMode");
  });
});

describe("mobile snippet usage sorting and quick-reply keyboard layout", () => {
  it("puts most used snippets at the top, breaks ties by recency, and preserves server order on equal ties", () => {
    const snippets = [
      {
        id: "s1",
        title: "Unused newer",
        content: "Unused",
        use_count: 0,
        last_used_at: 0,
      },
      {
        id: "s2",
        title: "Used once old",
        content: "Once old",
        use_count: 1,
        last_used_at: 400,
      },
      {
        id: "s3",
        title: "Most used",
        content: "Top",
        use_count: 5,
        last_used_at: 200,
      },
      {
        id: "s4",
        title: "Used once new",
        content: "Once new",
        use_count: 1,
        last_used_at: 900,
      },
      {
        id: "s5",
        title: "Unused older",
        content: "Unused 2",
        use_count: 0,
        last_used_at: 0,
      },
    ];
    expect(sortSnippetsByUsage(snippets).map((s) => s.id)).toEqual([
      "s3",
      "s4",
      "s2",
      "s1",
      "s5",
    ]);
    // Input array is never mutated, and fractional/missing/negative counts are sanitized safely.
    expect(snippets.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(
      sortSnippetsByUsage([
        { id: "a", use_count: -1, last_used_at: -5 },
        { id: "b", use_count: Number.NaN },
        { id: "c", use_count: 2.8, last_used_at: 10 },
      ]).map((s) => s.id),
    ).toEqual(["c", "a", "b"]);
  });

  it("sizes quick-reply sheet and scrollable area above an open keyboard", () => {
    const iosInset = computeKeyboardInset(
      { endCoordinates: { height: 336, screenY: 508 } },
      844,
      "ios",
    );
    expect(iosInset).toBe(336);
    expect(
      computeKeyboardInset(
        { endCoordinates: { height: 336, screenY: 844 } },
        844,
        "ios",
      ),
    ).toBe(0);

    // Android adjustResize already shrinks container height to screenY -> inset 0 (no double padding).
    expect(
      computeKeyboardInset(
        { endCoordinates: { height: 300, screenY: 544 } },
        544,
        "android",
      ),
    ).toBe(0);
    // Android overlay mode (non-shrinking container) computes exact keyboard height.
    expect(
      computeKeyboardInset(
        { endCoordinates: { height: 300, screenY: 544 } },
        844,
        "android",
      ),
    ).toBe(300);

    const openLayout = computeQuickSheetLayout({
      windowHeight: 844,
      insetTop: 59,
      insetBottom: 34,
      keyboardInset: iosInset,
    });
    expect(openLayout.maxSheetHeight).toBe(437);
    expect(openLayout.sheetPaddingBottom).toBe(12);
    expect(openLayout.maxScrollHeight).toBe(373);
    expect(openLayout.maxSheetHeight + iosInset + 59).toBeLessThanOrEqual(844);

    // Short landscape / split-screen window never pushes the sheet header above the top inset.
    const tightLayout = computeQuickSheetLayout({
      windowHeight: 390,
      insetTop: 20,
      insetBottom: 0,
      keyboardInset: 250,
    });
    expect(tightLayout.maxSheetHeight).toBe(108);
    expect(tightLayout.maxSheetHeight + 250 + 20).toBeLessThanOrEqual(390);
    expect(tightLayout.maxScrollHeight).toBe(44);

    const closedLayout = computeQuickSheetLayout({
      windowHeight: 844,
      insetTop: 59,
      insetBottom: 34,
      keyboardInset: 0,
    });
    expect(closedLayout.sheetPaddingBottom).toBe(48);
    expect(closedLayout.maxScrollHeight).toBeGreaterThan(
      openLayout.maxScrollHeight,
    );
  });
});

it("reuses a carousel snapshot within one paired client and coalesces its refresh", async () => {
  const session = {
    origin: "https://loop.example.com",
    cookie: "__Host-loop=fixture",
    csrf: "fixture",
    deviceName: "Fixture",
    pairedAt: 1,
  };
  const client = new LoopClient(session);
  const page: import("../apps/mobile/src/api/types.js").ApiConversationPage = {
    working: false,
    conversation: {
      id: "thread",
      title: "Result",
      agent_id: null,
      project_id: null,
    },
    messages: [],
    saved: [],
    next: null,
    steerable_run_id: null,
  };
  const fetchPage = vi.spyOn(client, "carouselPage").mockResolvedValue(page);
  const request = client.refreshCarouselPage("thread");
  expect(client.refreshCarouselPage("thread")).toBe(request);
  expect(await request).toBe(page);
  expect(client.cachedCarouselPage("thread")).toBe(page);
  expect(new LoopClient(session).cachedCarouselPage("thread")).toBeUndefined();
  expect(fetchPage).toHaveBeenCalledTimes(1);
  fetchPage.mockRejectedValueOnce(new Error("offline"));
  await expect(client.refreshCarouselPage("thread")).rejects.toThrow("offline");
  expect(client.cachedCarouselPage("thread")).toBe(page);
  await expect(client.refreshCarouselPage("thread")).resolves.toBe(page);
  expect(fetchPage).toHaveBeenCalledTimes(3);

  let completeOlder!: (value: typeof page) => void;
  fetchPage.mockReturnValueOnce(
    new Promise((resolve) => {
      completeOlder = resolve;
    }),
  );
  const olderRequest = client.refreshCarouselPage("thread", "running");
  const newPage = {
    ...page,
    conversation: { ...page.conversation, title: "Finished" },
  };
  fetchPage.mockResolvedValueOnce(newPage);
  await expect(client.refreshCarouselPage("thread", "completed")).resolves.toBe(
    newPage,
  );
  completeOlder(page);
  await olderRequest;
  expect(client.cachedCarouselPage("thread")).toBe(newPage);
  let completePreSave!: (value: typeof page) => void;
  fetchPage.mockReturnValueOnce(
    new Promise((resolve) => {
      completePreSave = resolve;
    }),
  );
  const preSave = client.refreshCarouselPage("thread");
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, saved: true }), { status: 200 }),
    );
  try {
    await client.setSaved("bookmark", true, "thread");
    completePreSave(newPage);
    await preSave;
    expect(client.cachedCarouselPage("thread")?.saved).toEqual(["bookmark"]);

    let finishUnsave!: (response: Response) => void;
    transport.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUnsave = resolve;
      }),
    );
    fetchPage.mockResolvedValueOnce(newPage);
    const unsave = client.setSaved("bookmark", false, "thread");
    const readsBefore = fetchPage.mock.calls.length;
    const reopened = client.refreshCarouselPage("thread");
    expect(fetchPage).toHaveBeenCalledTimes(readsBefore);
    finishUnsave(new Response(JSON.stringify({ ok: true, saved: false })));
    await unsave;
    expect((await reopened).saved).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(readsBefore + 1);
  } finally {
    transport.mockRestore();
  }
});

it("keeps the tapped older profile card in the first three carousel positions", () => {
  const cards = ["D", "C", "B", "A"].map(
    (id) => ({ id, messageId: id }) as NativeResultCard,
  );
  const recent = cards.slice(0, 3);
  expect(openingCarouselCardIds(cards, recent)).toEqual(["D", "C", "B"]);
  expect(
    openingCarouselCardIds(cards, recent, { ...cards[3], id: "profile-card" }),
  ).toEqual(["A", "D", "C"]);
  const newest = { id: "E", messageId: "E" } as NativeResultCard;
  const afterArrival = [newest, ...cards];
  expect(
    openingCarouselCardIds(
      afterArrival,
      afterArrival.slice(0, 3),
      cards[3],
      false,
    ),
  ).toEqual(["E", "D", "A"]);
});

it("preserves the older cursor boundary when refreshing during an older-page request", () => {
  const card = (id: string) => ({ id, messageId: id }) as NativeResultCard;
  const initial = { cards: ["C", "B", "A"].map(card), next: "before-A" };
  const latest = { cards: ["D", "C", "B"].map(card), next: "before-B" };
  const older = { cards: ["Z", "Y", "X"].map(card), next: "before-X" };
  const refreshed = mergeCarouselHistoryPage(initial, latest, "refresh");
  expect(refreshed.next).toBe("before-A");
  const paged = mergeCarouselHistoryPage(refreshed, older, {
    before: "before-A",
  });
  expect(paged.cards.map((item) => item.id)).toEqual([
    "D",
    "C",
    "B",
    "A",
    "Z",
    "Y",
    "X",
  ]);
  expect(paged.next).toBe("before-X");
  expect(
    mergeCarouselHistoryPage(
      mergeCarouselHistoryPage(initial, older, { before: "before-A" }),
      latest,
      "refresh",
    ),
  ).toEqual(paged);
});

it("uses the new cursor if the refreshed cards no longer overlap and ignores a late page", () => {
  const card = (id: string) => ({ id, messageId: id }) as NativeResultCard;
  const initial = { cards: ["C", "B", "A"].map(card), next: "before-A" };
  const latest = { cards: ["G", "F", "E"].map(card), next: "before-E" };
  const obsolete = { cards: ["Z"].map(card), next: null };
  const bridgingPage = { cards: ["D", "C", "B"].map(card), next: "before-B" };
  const refreshed = mergeCarouselHistoryPage(initial, latest, "refresh");
  expect(refreshed).toBe(latest);
  expect(
    mergeCarouselHistoryPage(refreshed, obsolete, { before: "before-A" }),
  ).toBe(latest);
  expect(
    mergeCarouselHistoryPage(refreshed, bridgingPage, {
      before: "before-E",
    }).cards.map(({ id }) => id),
  ).toEqual(["G", "F", "E", "D", "C", "B"]);
});

it("keeps the selected message when refreshed cards are inserted before it", () => {
  const cards = ["D", "C", "B", "A"].map(
    (messageId) => ({ id: "feed:" + messageId, messageId }) as NativeResultCard,
  );
  expect(resolveCarouselSelection(cards, { index: 1, key: "B" })).toBe(2);
  expect(resolveCarouselSelection(cards, { index: 1, key: "deleted" })).toBe(1);
});

it("reconciles an uncertain carousel save only with a read started afterward", () => {
  const edits = new Map([
    ["reply", { saved: true, revision: 4, uncertain: true }],
  ]);
  expect(reconcileCarouselSaves(edits, [], 3)).toBe(edits);
  expect(reconcileCarouselSaves(edits, [], 4).get("reply")).toEqual({
    saved: false,
    revision: 4,
  });
  expect(reconcileCarouselSaves(edits, ["reply"], 4).get("reply")).toEqual({
    saved: true,
    revision: 4,
  });
});

it("allows a fresh carousel read to update a settled save while preserving an in-flight edit", () => {
  const edits = new Map([
    ["settled", { saved: true, revision: 4 }],
    ["pending", { saved: true, revision: 2, pending: true }],
  ]);
  expect(reconcileCarouselSaves(edits, [], 3)).toBe(edits);
  const refreshed = reconcileCarouselSaves(edits, [], 4);
  expect(refreshed.get("settled")).toEqual({ saved: false, revision: 4 });
  expect(refreshed.get("pending")).toBe(edits.get("pending"));
});

it("preserves a re-probed paired device and treats a different device on the same URL as a new pairing", () => {
  const current = {
    origin: "https://loop.example.com",
    cookie: "loop=token",
    csrf: "old",
    deviceId: "device-a",
    pairedAt: 1,
    deviceName: "iPhone",
  };
  const probe = { ...current, cookie: "", csrf: "new", pairedAt: 2 };
  expect(isSamePairedDevice(current, probe)).toBe(true);
  expect(preserveProbedCredentials(current, probe)).toEqual({
    ...current,
    csrf: "new",
  });
  const replacement = { ...probe, deviceId: "device-b" };
  expect(isSamePairedDevice(current, replacement)).toBe(false);
  expect(preserveProbedCredentials(current, replacement)).toBe(replacement);
  expect(
    isSamePairedDevice(current, {
      ...current,
      origin: "https://other.example.com",
    }),
  ).toBe(false);
  const existingScope = assignPairingStorage(null, current, "nonce");
  const replacementScope = assignPairingStorage(
    existingScope,
    replacement,
    "new",
  );
  expect(localDataScope(current)).toBe(current.origin);
  expect(
    localDataScope(assignPairingStorage(existingScope, probe, "ignored")),
  ).toBe(localDataScope(existingScope));
  expect(localDataScope(replacementScope)).not.toBe(
    localDataScope(existingScope),
  );
  expect(localDataScope(replacementScope)).not.toBe(current.origin);
});
