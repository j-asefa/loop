import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  completeLeadingAgentMention,
  parseLeadingAgentMention,
  renderComposer,
  useComposerSend,
} from "../src/client/app/Composer";
import { PublicAgent } from "../src/shared/workspace-contract-schemas.js";
import { workspaceApi } from "../src/shared/workspace-api";
import type { Agent } from "../src/shared/types";

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

  it("renders inline @agent autocomplete suggestions with handoff badges and updates the reply chip", () => {
    vi.stubGlobal("window", {});
    try {
      const typingMention = renderComposer(
        baseComposerProps({
          threadMode: true,
          conversation: "conv-holly",
          conversationTarget: {
            agentId: "holly",
            conversationId: "conv-holly",
            title: "Cache audit",
            content: "The cache TTL is 5 minutes.",
          },
          replyContext: {
            agentId: "holly",
            conversationId: "conv-holly",
            messageId: "msg-1",
            content: "The cache TTL is 5 minutes.",
          },
          draft: "@m",
        }),
      );
      const suggestionHtml = renderToStaticMarkup(
        <>{typingMention.messageComposer}</>,
      );
      expect(suggestionHtml).toContain('aria-label="Mention agent"');
      expect(suggestionHtml).toContain("@mist");
      expect(suggestionHtml).toContain("Hand off");

      const completedMention = renderComposer(
        baseComposerProps({
          threadMode: true,
          conversation: "conv-holly",
          conversationTarget: {
            agentId: "holly",
            conversationId: "conv-holly",
            title: "Cache audit",
            content: "The cache TTL is 5 minutes.",
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
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards the quoted card or thread context when sending an @agent handoff", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
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
          content: "Finding 1: The cache TTL is 5 minutes.",
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
        composerData: { agents: [holly, mist], connections: [], folders: [] },
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
        saveThreadDraft: vi.fn(),
        setContextArtifact: vi.fn(),
        withdrawToComposer: async () => {},
        refresh: async () => {},
        setThreadNotice,
        setDismissNotice: vi.fn(),
      });

      await send();
      expect(threadApi).toHaveBeenCalledWith(workspaceApi.sharePreview, {
        body: { question: draft },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      const submitted = JSON.parse(String(init.body));
      expect(submitted.agentId).toBe("mist");
      expect(submitted.conversationId).toBeUndefined();
      expect(submitted.replyToMessageId).toBeUndefined();
      expect(submitted.input).toContain(
        "Replying to this earlier message from @holly:",
      );
      expect(submitted.input).toContain(
        "> Finding 1: The cache TTL is 5 minutes.",
      );
      expect(submitted.input).toContain(draft);
      expect(setThreadNotice).toHaveBeenCalledWith("Handed off to @mist.");
      expect(setSendNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "mist",
          agentName: "mist",
          conversationId: "conv-mist-1",
        }),
      );
      expect(setDraft).toHaveBeenCalledWith("");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
