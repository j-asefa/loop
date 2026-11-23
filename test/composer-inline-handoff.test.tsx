import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildHandoffInput,
  completeLeadingAgentMention,
  handoffQuote,
  parseLeadingAgentMention,
  renderComposer,
  useComposerSend,
} from "../src/client/app/Composer";
import {
  PublicAgent,
  PublicTeam,
} from "../src/shared/workspace-contract-schemas.js";
import { workspaceApi } from "../src/shared/workspace-api";
import type { Agent } from "../src/shared/types";
import type { ComposerContext } from "../src/client/composerContext";

function agent(
  id: string,
  name: string,
  retiredAt: number | null = null,
): Agent {
  return PublicAgent.parse({
    id,
    owner_id: "owner",
    name,
    provider: "anthropic",
    connection_id: "conn-1",
    model: "claude",
    instructions: "",
    origin: "loop",
    created_at: 0,
    retired_at: retiredAt,
  });
}

function baseComposerProps(
  overrides: Partial<Parameters<typeof renderComposer>[0]> = {},
): Parameters<typeof renderComposer>[0] {
  const holly = agent("holly", "holly");
  const mist = agent("mist", "mist");
  const both = [holly, mist];
  return {
    profile: null,
    replyContext: null,
    replyQuoted: undefined,
    contextArtifact: null,
    conversation: null,
    threadMode: false,
    selected: "holly",
    routePreview: null,
    busy: false,
    uploading: false,
    draft: "",
    activeAgent: holly,
    conversationTarget: null,
    send: async () => {},
    sendPress: {} as Parameters<typeof renderComposer>[0]["sendPress"],
    composerData: { agents: both, connections: [], folders: [] },
    availableAgents: both,
    composerRef: { current: null },
    composerExpanded: true,
    workspaceReady: true,
    composerOptions: false,
    setComposerOptions: vi.fn(),
    startChat: vi.fn(),
    sendNotice: null,
    sentRun: undefined,
    setSelected: vi.fn(),
    setConversation: vi.fn(),
    setSendNotice: vi.fn(),
    attachments: [],
    session: { user: { id: "owner" } },
    setContextArtifact: vi.fn(),
    setFolderChoice: vi.fn(),
    setFolder: vi.fn(),
    focusComposer: vi.fn(),
    destination: {
      agent: "holly",
      project: "Unfiled",
      thread: "New thread",
    },
    data: { agents: both },
    setReplyContext: vi.fn(),
    collapseComposer: vi.fn(),
    steersActive: false,
    setDraft: vi.fn(),
    setComposerExpanded: vi.fn(),
    setAttachments: vi.fn(),
    composerError: "",
    setComposerError: vi.fn(),
    folderChoice: undefined,
    threadIdentity: "thread",
    setUploading: vi.fn(),
    viewIdentity: "view",
    threadIdentityRef: { current: "view" },
    attachmentsRef: { current: [] },
    setSheet: vi.fn(),
    setModelAgent: vi.fn(),
    setSendMenu: vi.fn(),
    threadWork: null,
    threadNotice: "",
    setThreadNotice: vi.fn(),
    ...overrides,
  };
}

describe("inline @agent mention and handoff in composer", () => {
  const holly = agent("holly", "holly");
  const mist = agent("mist", "mist");
  const retired = agent("old", "old", 100);
  const agents = [holly, mist, retired];

  it("parses leading @agent prefixes and completed handles while skipping retired and @new", () => {
    expect(parseLeadingAgentMention("Hello @mist", agents)).toBeNull();
    expect(parseLeadingAgentMention("@new Build a tool", agents)).toBeNull();

    const emptyPrefix = parseLeadingAgentMention("@", agents);
    expect(emptyPrefix?.completed).toBe(false);
    expect(emptyPrefix?.suggestions.map((a) => a.name)).toEqual([
      "holly",
      "mist",
    ]);

    const partial = parseLeadingAgentMention("@mi", agents);
    expect(partial?.completed).toBe(false);
    expect(partial?.agent).toBeUndefined();
    expect(partial?.suggestions.map((a) => a.name)).toEqual(["mist"]);

    const completed = parseLeadingAgentMention(
      "@mist Compare this with production",
      agents,
    );
    expect(completed?.completed).toBe(true);
    expect(completed?.agent?.id).toBe("mist");
    expect(completed?.suggestions).toEqual([]);

    expect(completeLeadingAgentMention("@mi", "mist")).toBe("@mist ");
    expect(completeLeadingAgentMention("@mi check this", "mist")).toBe(
      "@mist check this",
    );
  });

  it("requires an explicit messageId or artifactId and known author for handoffQuote, and caps buildHandoffInput at 30000 chars", () => {
    expect(
      handoffQuote(
        {
          agentId: "holly",
          conversationId: "conv-holly",
          title: "Thread without messageId",
          content: "Should not be quoted after clear",
        },
        "mist",
        [holly, mist],
      ),
    ).toBeNull();

    expect(
      handoffQuote(
        {
          agentId: "unknown-agent",
          conversationId: "conv-1",
          messageId: "msg-1",
          content: "Orphaned author",
        },
        "mist",
        [holly, mist],
      ),
    ).toBeNull();

    const valid = handoffQuote(
      {
        agentId: "holly",
        conversationId: "conv-holly",
        messageId: "msg-1",
        content: "The cache TTL is 5 minutes.",
      },
      "mist",
      [holly, mist],
    );
    expect(valid).toEqual({
      id: "msg-1",
      content: "The cache TTL is 5 minutes.",
      authorName: "holly",
      mine: undefined,
      excerpt: undefined,
    });

    const longDraft = "@mist " + "a".repeat(29_800);
    const bounded = buildHandoffInput(longDraft, {
      id: "msg-1",
      content: "b".repeat(5_000),
      authorName: "holly",
    });
    expect(bounded.length).toBeLessThanOrEqual(30_000);
    expect(bounded).toContain(longDraft);
  });

  it("renders inline @agent autocomplete suggestions with handoff badges, uses peer agents in remote threads, and omits quote when cleared", () => {
    vi.stubGlobal("window", {});
    try {
      const peerAlpha = agent("peer-alpha", "alpha");
      const peerBeta = agent("peer-beta", "beta");
      const peerTyping = renderComposer(
        baseComposerProps({
          threadMode: true,
          conversation: "conv-peer",
          activeAgent: peerAlpha,
          availableAgents: [holly, mist],
          composerData: {
            agents: [peerAlpha, peerBeta],
            connections: [],
            folders: [],
          },
          conversationTarget: {
            agentId: "peer-alpha",
            conversationId: "conv-peer",
            title: "Remote audit",
          },
          replyContext: {
            agentId: "peer-alpha",
            conversationId: "conv-peer",
            messageId: "msg-peer-1",
            content: "Remote finding.",
          },
          draft: "@b",
        }),
      );
      const suggestionHtml = renderToStaticMarkup(
        <>{peerTyping.messageComposer}</>,
      );
      expect(suggestionHtml).toContain('aria-label="Mention agent"');
      expect(suggestionHtml).toContain("@beta");
      expect(suggestionHtml).not.toContain("@holly");
      expect(suggestionHtml).toContain("Hand off");

      const completedMention = renderComposer(
        baseComposerProps({
          threadMode: true,
          conversation: "conv-holly",
          conversationTarget: {
            agentId: "holly",
            conversationId: "conv-holly",
            title: "Cache audit",
          },
          replyContext: {
            agentId: "holly",
            conversationId: "conv-holly",
            messageId: "msg-1",
            content: "The cache TTL is 5 minutes.",
          },
          replyQuoted: false,
          draft: "@mist Compare this with the staging TTL.",
        }),
      );
      const handoffHtml = renderToStaticMarkup(
        <>{completedMention.messageComposer}</>,
      );
      expect(handoffHtml).toContain("Replying to @holly with @mist:");
      expect(handoffHtml).toContain("The cache TTL is 5 minutes.");
      expect(handoffHtml).toContain("Send hands this reply off to @mist.");

      // After clicking "Clear reply context", replyContext resets to conversationTarget (no messageId/artifactId).
      const clearedQuote = renderComposer(
        baseComposerProps({
          threadMode: true,
          conversation: "conv-holly",
          conversationTarget: {
            agentId: "holly",
            conversationId: "conv-holly",
            title: "Cache audit",
          },
          replyContext: {
            agentId: "holly",
            conversationId: "conv-holly",
            title: "Cache audit",
          },
          replyQuoted: false,
          draft: "@mist Compare this with the staging TTL.",
        }),
      );
      const clearedHtml = renderToStaticMarkup(
        <>{clearedQuote.messageComposer}</>,
      );
      expect(clearedHtml).not.toContain("composer-reply-chip");
      expect(clearedHtml).toContain("Send hands this reply off to @mist.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards quoted replyContext on @agent handoff and freezes the idempotency key and embedded input across uncertain retries", async () => {
    let shouldFail = true;
    const fetchMock = vi.fn(async () => {
      if (shouldFail) {
        return new Response(
          JSON.stringify({ error: "Upstream temporarily unavailable" }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: "run-mist-1",
          agent_id: "mist",
          conversation_id: "conv-mist-1",
          input: "@mist Compare this with the staging config.",
          payload: "{}",
          created_at: 1,
          updated_at: 1,
          state: "running",
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { querySelector: () => null });
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    try {
      const draft = "@mist Compare this with the staging config.";
      const threadApi = vi.fn(async (contract) => {
        if (contract === workspaceApi.sharePreview)
          return {
            mode: "queue",
            agent: {
              id: "mist",
              name: "mist",
              provider: "anthropic",
              model: "claude",
            },
          };
        throw new Error("Unexpected threadApi call");
      });
      const setSendNotice = vi.fn();
      const setThreadNotice = vi.fn();
      const setDraft = vi.fn();
      const saveThreadDraft = vi.fn();
      const requestBox = {
        current: { signature: "", key: "", unquoted: false },
      };
      const makeSend = (replyContext: ComposerContext | null) =>
        useComposerSend({
          replyQuoted: false,
          busy: false,
          uploading: false,
          draft,
          conversation: "conv-holly",
          conversationTarget: {
            agentId: "holly",
            conversationId: "conv-holly",
            title: "Cache audit",
          },
          viewIdentity: "view-1",
          threadIdentityRef: { current: "view-1" },
          threadIdentity: "composer-1",
          composerIdentityRef: { current: "composer-1" },
          draftRef: { current: draft },
          attachmentsRef: { current: [] },
          attachments: [],
          setNewAgentPrompt: vi.fn(),
          setFolder: vi.fn(),
          projectFilter: "",
          project: "",
          setSheet: vi.fn(),
          replyContext,
          contextArtifact: null,
          setError: vi.fn(),
          threadApi: threadApi as unknown as Parameters<
            typeof useComposerSend
          >[0]["threadApi"],
          setFilingResult: vi.fn(),
          setFiling: vi.fn(),
          setDraft,
          changed: async () => {},
          selected: "holly",
          routePreview: null,
          folder: "",
          setBusy: vi.fn(),
          setRoutePreview: vi.fn(),
          activeAgent: holly,
          setComposerError: vi.fn(),
          composerUnavailable: undefined,
          ownerRef: { current: "owner" },
          composerData: {
            agents: [holly, mist],
            connections: [],
            folders: [],
            teams: [
              PublicTeam.parse({
                id: "team-1",
                name: "Team",
                manager_id: "mist",
                conversation_id: "conv-team-mist",
                members: ["holly"],
              }),
            ],
          },
          profile: null,
          teamSelection: [],
          folderChoice: undefined,
          draftId: (id) => id,
          request: requestBox,
          receiptStorageKey: "receipt-key",
          pendingDraftSave: { current: null },
          draftKey: "draft-key",
          openSourceLater: vi.fn(),
          actionSource: "",
          setAttachments: vi.fn(),
          setReplyContext: vi.fn(),
          collapseComposer: vi.fn(),
          runsGeneration: { current: 0 },
          setRuns: vi.fn(),
          setSendNotice,
          saveThreadDraft,
          setContextArtifact: vi.fn(),
          withdrawToComposer: async () => {},
          refresh: async () => {},
          setThreadNotice,
          setDismissNotice: vi.fn(),
        });

      // Attempt 1 fails with 503 (uncertain outcome).
      await makeSend({
        agentId: "holly",
        conversationId: "conv-holly",
        messageId: "msg-holly-1",
        content: "Finding 1: The cache TTL is 5 minutes.",
      })();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const firstBody = JSON.parse(
        String(
          (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
        ),
      );
      expect(firstBody.agentId).toBe("mist");
      expect(firstBody.input).toContain(
        "Replying to this earlier message from @holly:",
      );
      expect(firstBody.input).toContain(
        "> Finding 1: The cache TTL is 5 minutes.",
      );
      expect(firstBody.input).toContain(draft);

      // Attempt 2 succeeds even if the message text in replyContext changed in the meantime:
      // it reuses the exact same idempotencyKey and frozen input from Attempt 1.
      shouldFail = false;
      await makeSend({
        agentId: "holly",
        conversationId: "conv-holly",
        messageId: "msg-holly-1",
        content: "Finding 1: Updated streaming text that arrived later.",
      })();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondBody = JSON.parse(
        String(
          (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body,
        ),
      );
      expect(secondBody.idempotencyKey).toBe(firstBody.idempotencyKey);
      expect(secondBody.input).toBe(firstBody.input);
      expect(setThreadNotice).toHaveBeenCalledWith("Handed off to @mist.");
      expect(setSendNotice).not.toHaveBeenCalled();
      // Must not overwrite @mist's team conversation draft when handing off from @holly's thread.
      expect(saveThreadDraft).not.toHaveBeenCalled();
      expect(setDraft).toHaveBeenCalledWith("");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
