import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  completeLeadingAgentMention,
  MAX_COMPOSER_RECIPIENTS,
  parseLeadingAgentMention,
  renderComposer,
  renderComposerSendSheets,
  resolveExtraComposerAgents,
  toggleExtraRecipientId,
  useComposerSend,
} from "../src/client/app/Composer";
import { listenClientEvent } from "../src/client/clientEvents";
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

    const misty = agent("misty", "misty");
    const exactOverPrefix = parseLeadingAgentMention("@mist", [
      misty,
      mist,
      holly,
    ]);
    expect(exactOverPrefix?.agent?.id).toBe("mist");
    expect(exactOverPrefix?.suggestions.map((a) => a.name)).toEqual([
      "mist",
      "misty",
    ]);

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
      expect(handoffHtml).not.toContain("This agent is retired.");

      // Walk the element tree to exercise Tab, Shift+Tab, and suggestion click handlers directly.
      const findElements = (
        node: unknown,
        predicate: (el: {
          type: unknown;
          props: Record<string, any>;
        }) => boolean,
        out: { type: unknown; props: Record<string, any> }[] = [],
      ) => {
        if (!node || typeof node !== "object") return out;
        if (Array.isArray(node)) {
          for (const child of node) findElements(child, predicate, out);
          return out;
        }
        const el = node as { type?: unknown; props?: Record<string, any> };
        if (el.props) {
          if (predicate(el as { type: unknown; props: Record<string, any> }))
            out.push(el as { type: unknown; props: Record<string, any> });
          findElements(el.props.children, predicate, out);
        }
        return out;
      };
      const misty = agent("misty", "misty");
      const setDraft = vi.fn();
      const interactive = renderComposer(
        baseComposerProps({
          composerData: {
            agents: [misty, mist, holly],
            connections: [],
            folders: [],
          },
          availableAgents: [misty, mist, holly],
          draft: "@mist",
          setDraft,
        }),
      );
      const textarea = findElements(
        interactive.messageComposer,
        (el) => el.type === "textarea" && el.props.id === "composer",
      )[0];
      expect(textarea).toBeDefined();
      // Shift+Tab must not swallow focus navigation or rewrite the draft.
      textarea.props.onKeyDown({
        key: "Tab",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
      });
      expect(setDraft).not.toHaveBeenCalled();
      // Unmodified Tab completes the exact match (@mist) ahead of @misty.
      const preventDefault = vi.fn();
      textarea.props.onKeyDown({
        key: "Tab",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault,
      });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(setDraft).toHaveBeenCalledWith("@mist ");

      // Clicking a suggestion pill completes its handle.
      const pills = findElements(
        interactive.messageComposer,
        (el) => el.props.role === "option",
      );
      expect(pills).toHaveLength(2);
      vi.stubGlobal("document", { getElementById: () => null });
      pills[1].props.onClick();
      expect(setDraft).toHaveBeenLastCalledWith("@misty ");

      // Send options and Send later sheets reflect @mist during an inline handoff.
      const sheets = renderComposerSendSheets({
        sendMenu: true,
        setSendMenu: vi.fn(),
        threadMode: true,
        threadWork: { steerable: true, state: "running" },
        destination: {
          agent: "holly",
          project: "Holly project",
          thread: "Holly thread",
        },
        handoffAgent: completedMention.handoffAgent,
        send: async () => {},
        steersActive: true,
        setScheduleAt: vi.fn(),
        scheduleAt: "2026-12-01T10:00",
        draft: "@mist Compare this with the staging TTL.",
        busy: false,
        setComposerError: vi.fn(),
      });
      const sendOptionElements = findElements(
        sheets,
        (el) =>
          Array.isArray(el.props.actions) && el.props.title === "Send options",
      );
      expect(sendOptionElements).toHaveLength(1);
      expect(sendOptionElements[0].props.actions[0].label).toBe("Send now");
      expect(sendOptionElements[0].props.actions[0].hint).toBeUndefined();
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
    vi.stubGlobal("window", new EventTarget());
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

      await send();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        String(
          (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
        ),
      );
      expect(body.agentId).toBe("mist");
      expect(body.input).toBe(draft);
      expect(body.replyToMessageId).toBeUndefined();
      expect(setThreadNotice).toHaveBeenCalledWith("Sent to @mist.");
      expect(setSendNotice).not.toHaveBeenCalled();
      // Clears only the source thread's draft ("conv-holly"), never @mist's team thread ("conv-team-mist").
      expect(saveThreadDraft).toHaveBeenCalledTimes(1);
      expect(saveThreadDraft).toHaveBeenCalledWith("conv-holly", "", []);
      expect(setDraft).toHaveBeenCalledWith("");

      // Queued in-thread handoff preserves withdrawToComposer Undo toast instead of dropping it.
      const toasts: { text: string; undo?: () => Promise<void> | void }[] = [];
      const unsubscribe = listenClientEvent("loop-toast", (toast) => {
        if (toast) toasts.push(toast);
      });
      const withdrawToComposer = vi.fn(async () => {});
      try {
        const queuedSend = useComposerSend({
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
          replyContext: null,
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
            teams: [],
          },
          profile: null,
          teamSelection: [],
          folderChoice: undefined,
          draftId: (id) => id,
          request: { current: { signature: "", key: "", unquoted: false } },
          receiptStorageKey: "receipt-key-2",
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
          withdrawToComposer,
          refresh: async () => {},
          setThreadNotice,
          setDismissNotice: vi.fn(),
        });
        await queuedSend({ queue: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const queuedBody = JSON.parse(
          String(
            (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
              .body,
          ),
        );
        expect(queuedBody.queue).toBe(true);
        const queuedToast = toasts.find((t) =>
          t.text.includes("Queued for @mist."),
        );
        expect(queuedToast).toBeDefined();
        await queuedToast?.undo?.();
        expect(withdrawToComposer).toHaveBeenCalledWith("run-mist-1");
      } finally {
        unsubscribe();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves and toggles up to 2 extra connected recipients in new-thread composer mode", () => {
    vi.stubGlobal("window", {});
    try {
      const vera = agent("vera", "vera");
      const fourth = agent("zen", "zen");
      const allAgents = [holly, mist, vera, fourth, retired, unconnected];

      expect(MAX_COMPOSER_RECIPIENTS).toBe(3);
      expect(toggleExtraRecipientId([], "mist", "holly")).toEqual(["mist"]);
      expect(toggleExtraRecipientId(["mist"], "vera", "holly")).toEqual([
        "mist",
        "vera",
      ]);
      // Caps extra recipients at 2 (3 total including primary).
      expect(toggleExtraRecipientId(["mist", "vera"], "zen", "holly")).toEqual([
        "mist",
        "vera",
      ]);
      // Toggling an already-selected extra recipient removes it.
      expect(toggleExtraRecipientId(["mist", "vera"], "mist", "holly")).toEqual(
        ["vera"],
      );
      // Ignores toggling the primary recipient.
      expect(toggleExtraRecipientId(["mist"], "holly", "holly")).toEqual([
        "mist",
      ]);
      // Prunes stale, retired, or unconnected IDs before enforcing the cap.
      const eligible = new Set(["holly", "mist", "vera", "zen"]);
      expect(
        toggleExtraRecipientId(
          ["old", "unconn", "mist"],
          "vera",
          "holly",
          eligible,
        ),
      ).toEqual(["mist", "vera"]);

      expect(
        resolveExtraComposerAgents({
          extraRecipients: ["mist", "holly", "old", "unconn", "vera", "zen"],
          availableAgents: allAgents,
          activeAgent: holly,
          selected: "holly",
          replyContext: null,
          contextArtifact: null,
          draft: "Compare these approaches",
        }).map((a) => a.id),
      ).toEqual(["mist", "vera"]);

      // Disabled in thread mode, reply context, route preview, @mention, or filing command.
      expect(
        resolveExtraComposerAgents({
          extraRecipients: ["mist"],
          availableAgents: allAgents,
          activeAgent: holly,
          selected: "holly",
          threadMode: true,
          conversation: "conv-1",
          replyContext: null,
          contextArtifact: null,
          draft: "Compare these approaches",
        }),
      ).toEqual([]);
      expect(
        resolveExtraComposerAgents({
          extraRecipients: ["mist"],
          availableAgents: allAgents,
          activeAgent: holly,
          selected: "holly",
          replyContext: {
            agentId: "holly",
            conversationId: "conv-1",
            messageId: "msg-1",
            content: "Earlier message",
          },
          contextArtifact: null,
          draft: "Compare these approaches",
        }),
      ).toEqual([]);
      expect(
        resolveExtraComposerAgents({
          extraRecipients: ["mist"],
          availableAgents: allAgents,
          activeAgent: holly,
          selected: "holly",
          replyContext: null,
          contextArtifact: null,
          draft: "@vera Compare these approaches",
        }),
      ).toEqual([]);

      const multiView = renderComposer(
        baseComposerProps({
          availableAgents: [holly, mist, vera, fourth],
          composerData: {
            agents: [holly, mist, vera, fourth],
            connections: [],
            folders: [],
          },
          data: { agents: [holly, mist, vera, fourth] },
          extraRecipients: ["mist", "vera"],
          setExtraRecipients: vi.fn(),
          draft: "Give me an independent architecture review.",
        }),
      );
      const html = renderToStaticMarkup(<>{multiView.messageComposer}</>);
      expect(html).toContain("Sends to @holly, @mist, @vera");
      expect(html).toContain("Send (3)");
      expect(html).toContain('aria-label="Remove @mist from recipients"');
      expect(html).toContain('aria-label="Remove @vera from recipients"');
      expect(html).toContain('aria-label="Also send to @zen"');
      expect(html).toContain('title="Select up to 3 agents" disabled=""');

      // A retired primary agent disables Send and never fans out to extra recipients.
      const retiredPrimaryView = renderComposer(
        baseComposerProps({
          selected: "old",
          activeAgent: retired,
          extraRecipients: ["mist", "vera"],
          draft: "Give me an independent architecture review.",
        }),
      );
      expect(retiredPrimaryView.extraAgents).toEqual([]);
      const retiredHtml = renderToStaticMarkup(
        <>{retiredPrimaryView.messageComposer}</>,
      );
      expect(retiredHtml).not.toContain("Sends to @old");
      expect(retiredHtml).toContain('aria-label="Send message"');
      expect(retiredHtml).toContain("This agent is retired.");

      const sheets = renderComposerSendSheets({
        sendMenu: true,
        setSendMenu: vi.fn(),
        threadMode: false,
        threadWork: null,
        destination: {
          agent: "holly",
          project: "Unfiled",
          thread: "New thread",
        },
        extraAgents: multiView.extraAgents,
        send: async () => {},
        steersActive: true,
        setScheduleAt: vi.fn(),
        scheduleAt: "2026-12-01T10:00",
        draft: "Give me an independent architecture review.",
        busy: false,
        setComposerError: vi.fn(),
      });
      const sheetChildrenHtml = renderToStaticMarkup(
        <>
          {(sheets.props.children as { props?: { children?: unknown } }[]).map(
            (child, i) => (
              <div key={i}>{child?.props?.children as any}</div>
            ),
          )}
        </>,
      );
      expect(sheetChildrenHtml).toContain("@holly, @mist, @vera");
      expect(sheetChildrenHtml).not.toContain("Unfiled");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("multi-agent send", () => {
    const vera = agent("vera", "vera");
    const runFor = (body: { agentId: string; input: string }) =>
      new Response(
        JSON.stringify({
          id: `run-${body.agentId}`,
          agent_id: body.agentId,
          conversation_id: `conv-${body.agentId}`,
          input: body.input,
          payload: "{}",
          created_at: 1,
          updated_at: 1,
          state: "running",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    const sent = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls.map(
        (call) =>
          JSON.parse(String((call as [string, RequestInit])[1].body)) as {
            agentId: string;
            idempotencyKey: string;
          },
      );

    function setup(failing: Set<string>, status = 503) {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (failing.has(body.agentId))
          return new Response(JSON.stringify({ error: "Gateway timeout" }), {
            status,
            headers: { "content-type": "application/json" },
          });
        return runFor(body);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("document", { querySelector: () => null });
      const storage = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      });
      const state = { extras: ["vera", "mist"] };
      const dropExtraRecipient = vi.fn((id: string) => {
        state.extras = state.extras.filter((entry) => entry !== id);
      });
      const setComposerError = vi.fn();
      const setDraft = vi.fn();
      const setSendNotice = vi.fn();
      const threadApi = vi.fn(async (_route: unknown, input: any) =>
        input?.body?.sendAt
          ? { id: `scheduled-${input.body.agentId}` }
          : undefined,
      );
      const request = { current: { signature: "", key: "", unquoted: false } };
      const send = (
        draft: string,
        overrides: Partial<Parameters<typeof useComposerSend>[0]> = {},
      ) =>
        useComposerSend({
          replyQuoted: false,
          busy: false,
          uploading: false,
          draft,
          conversation: null,
          conversationTarget: null,
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
          replyContext: null,
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
          extraRecipients: state.extras,
          dropExtraRecipient,
          availableAgents: [holly, mist, vera],
          routePreview: null,
          folder: "",
          setBusy: vi.fn(),
          setRoutePreview: vi.fn(),
          activeAgent: holly,
          setComposerError,
          composerUnavailable: undefined,
          ownerRef: { current: "owner" },
          composerData: {
            agents: [holly, mist, vera],
            connections: [],
            folders: [],
            teams: [],
          },
          profile: null,
          teamSelection: [],
          folderChoice: undefined,
          draftId: (id) => id,
          request,
          receiptStorageKey: "multi-receipt-key",
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
          setThreadNotice: vi.fn(),
          setDismissNotice: vi.fn(),
          ...overrides,
        });
      return {
        fetchMock,
        state,
        dropExtraRecipient,
        setComposerError,
        setDraft,
        setSendNotice,
        threadApi,
        send,
      };
    }

    it("sends extras first and the selected agent last, then retries only the agents that did not accept", async () => {
      const failing = new Set(["mist"]);
      const t = setup(failing);
      try {
        const draft = "Compare WAL with the rollback journal.";
        await t.send(draft)();
        const first = sent(t.fetchMock);
        // vera accepted, mist uncertain (503); holly, the selected agent, waits.
        expect(first.map((body) => body.agentId)).toEqual(["vera", "mist"]);
        expect(first[0].idempotencyKey).not.toBe(first[1].idempotencyKey);
        expect(t.dropExtraRecipient).toHaveBeenCalledWith("vera");
        expect(t.state.extras).toEqual(["mist"]);
        expect(t.setDraft).not.toHaveBeenCalledWith("");
        expect(t.setComposerError).toHaveBeenLastCalledWith(
          "Sent to @vera. Not sent to the others: Gateway timeout",
        );

        // The retry sends to mist with its uncertain key, then holly; vera
        // already accepted and is no longer a recipient.
        failing.clear();
        await t.send(draft)();
        const retry = sent(t.fetchMock).slice(2);
        expect(retry.map((body) => body.agentId)).toEqual(["mist", "holly"]);
        expect(retry[0].idempotencyKey).toBe(first[1].idempotencyKey);
        expect(t.setDraft).toHaveBeenCalledWith("");
        expect(t.setSendNotice).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentId: "holly",
            recipientNames: ["mist", "holly"],
          }),
        );

        // Sending the same text to vera alone later is new work with a new
        // key, not a replay of the accepted batch send.
        await t.send(draft, {
          selected: "vera",
          activeAgent: vera,
          extraRecipients: [],
        })();
        const alone = sent(t.fetchMock).at(-1)!;
        expect(alone.agentId).toBe("vera");
        expect(alone.idempotencyKey).not.toBe(first[0].idempotencyKey);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps a refused agent in the composer and reports who already accepted", async () => {
      const t = setup(new Set(["mist"]), 409);
      try {
        await t.send("Review the migration plan.")();
        expect(sent(t.fetchMock).map((body) => body.agentId)).toEqual([
          "vera",
          "mist",
        ]);
        expect(t.state.extras).toEqual(["mist"]);
        expect(t.setComposerError).toHaveBeenLastCalledWith(
          "Sent to @vera. Not sent to the others: Gateway timeout",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("schedules each agent once and Undo cancels every scheduled send", async () => {
      const t = setup(new Set());
      const toasts: { text: string; undo?: () => Promise<void> | void }[] = [];
      const unsubscribe = listenClientEvent("loop-toast", (toast) => {
        if (toast) toasts.push(toast);
      });
      try {
        const sendAt = Date.UTC(2026, 11, 1, 10, 0);
        await t.send("Post the weekly summary.")({ sendAt });
        const created = t.threadApi.mock.calls
          .filter(([route]) => route === workspaceApi.scheduledSendCreate)
          .map(([, input]) => (input as any).body.agentId);
        expect(created).toEqual(["vera", "mist", "holly"]);
        expect(t.state.extras).toEqual([]);
        const toast = toasts.at(-1)!;
        expect(toast.text).toMatch(/^Scheduled for @vera, @mist, @holly, /);
        // vera's send already went out, so its cancel is refused; the
        // others are still cancelled and the draft comes back.
        t.threadApi.mockImplementation(async (route: unknown, input: any) => {
          if (
            route === workspaceApi.scheduledSendCancel &&
            input.params.id === "scheduled-vera"
          )
            throw Object.assign(new Error("Already sent"), { status: 409 });
          return undefined;
        });
        await expect(toast.undo?.()).rejects.toThrow(
          "Cancelled 2 of 3 scheduled sends. Already sent",
        );
        const cancelled = t.threadApi.mock.calls
          .filter(([route]) => route === workspaceApi.scheduledSendCancel)
          .map(([, input]) => (input as any).params.id);
        expect(cancelled).toEqual([
          "scheduled-vera",
          "scheduled-mist",
          "scheduled-holly",
        ]);
        expect(t.setDraft).toHaveBeenCalledWith(expect.any(Function));
      } finally {
        unsubscribe();
        vi.unstubAllGlobals();
      }
    });

    it("offers Undo for agents already scheduled when a scheduled batch stops early", async () => {
      const t = setup(new Set());
      const toasts: { text: string; undo?: () => Promise<void> | void }[] = [];
      const unsubscribe = listenClientEvent("loop-toast", (toast) => {
        if (toast) toasts.push(toast);
      });
      try {
        t.threadApi.mockImplementation(async (route: unknown, input: any) => {
          if (route === workspaceApi.scheduledSendCreate) {
            if (input.body.agentId === "mist")
              throw Object.assign(new Error("Refused"), { status: 409 });
            return { id: `scheduled-${input.body.agentId}` };
          }
          return undefined;
        });
        await t.send("Post the weekly summary.")({
          sendAt: Date.UTC(2026, 11, 1, 10, 0),
        });
        expect(t.state.extras).toEqual(["mist"]);
        expect(t.setComposerError).toHaveBeenLastCalledWith(
          "Scheduled for @vera. Not sent to the others: Refused",
        );
        const toast = toasts.at(-1)!;
        expect(toast.text).toBe(
          "Scheduled for @vera. The others were not scheduled.",
        );
        await toast.undo?.();
        expect(
          t.threadApi.mock.calls
            .filter(([route]) => route === workspaceApi.scheduledSendCancel)
            .map(([, input]) => (input as any).params.id),
        ).toEqual(["scheduled-vera"]);
      } finally {
        unsubscribe();
        vi.unstubAllGlobals();
      }
    });
  });
});
