import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  completeLeadingAgentMention,
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

function agent(
  id: string,
  name: string,
  options: { retiredAt?: number | null; connectionId?: string | null } = {},
): Agent {
  return PublicAgent.parse({
    id,
    owner_id: "owner",
    name,
    provider: "anthropic",
    connection_id:
      options.connectionId === undefined ? "conn-1" : options.connectionId,
    model: "claude",
    instructions: "",
    origin: "loop",
    created_at: 0,
    retired_at: options.retiredAt ?? null,
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
  const retired = agent("old", "old", { retiredAt: 100 });
  const unconnected = agent("unconn", "unconn", { connectionId: null });
  const agents = [holly, mist, retired, unconnected];

  it("parses leading @agent prefixes and completed handles while skipping retired, unconnected, and @new", () => {
    expect(parseLeadingAgentMention("Hello @mist", agents)).toBeNull();
    expect(parseLeadingAgentMention("@new Build a tool", agents)).toBeNull();
    expect(
      parseLeadingAgentMention("@new-bot Build a tool", agents),
    ).toBeNull();

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

  it("renders inline @agent autocomplete suggestions with handoff badges, uses peer agents in remote threads, and hides same-thread reply chip when addressing another agent", () => {
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
          activeAgent: retired,
          conversationTarget: {
            agentId: "old",
            conversationId: "conv-holly",
            title: "Cache audit",
          },
          replyContext: {
            agentId: "old",
            conversationId: "conv-holly",
            messageId: "msg-1",
            content: "The cache TTL is 5 minutes.",
          },
          replyQuoted: true,
          draft: "@mist Compare this with the staging TTL.",
        }),
      );
      const handoffHtml = renderToStaticMarkup(
        <>{completedMention.messageComposer}</>,
      );
      expect(handoffHtml).not.toContain("composer-reply-chip");
      expect(handoffHtml).toContain("Sends to @mist.");
      expect(handoffHtml).not.toContain('aria-label="Send reply" disabled=""');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports in-thread @agent handoffs and preserves other threads' saved drafts", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "run-mist-1",
            agent_id: "mist",
            conversation_id: "conv-team-mist",
            input: "@mist Compare this with the staging config.",
            payload: "{}",
            created_at: 1,
            updated_at: 1,
            state: "queued",
          }),
          {
            status: 202,
            headers: { "content-type": "application/json" },
          },
        ),
    );
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
      const send = useComposerSend({
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
        replyContext: {
          agentId: "holly",
          conversationId: "conv-holly",
          messageId: "msg-holly-1",
          content: "Finding 1: The cache TTL is 5 minutes.",
        },
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
        request: { current: { signature: "", key: "", unquoted: false } },
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

      await send({ queue: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        String(
          (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
        ),
      );
      expect(body.agentId).toBe("mist");
      expect(body.input).toBe(draft);
      expect(body.replyToMessageId).toBeUndefined();
      expect(setThreadNotice).toHaveBeenCalledWith("Queued for @mist.");
      expect(setSendNotice).not.toHaveBeenCalled();
      expect(saveThreadDraft).not.toHaveBeenCalled();
      expect(setDraft).toHaveBeenCalledWith("");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
