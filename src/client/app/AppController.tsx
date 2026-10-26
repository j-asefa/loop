import { useComposerDraft, useComposerSend } from "./Composer";
import { type ResultItem } from "../../shared/workspace-api";
import { type WorkspaceCollection } from "../../shared/workspace-events";
import { cardArtifact, type CardArtifact } from "../card-actions";
import { CardPager } from "../card-pager";
import { cardReader } from "../../shared/card-client";

import { type MyProfileData } from "../MyProfile";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../../shared/uploads";
import { useProjectionRead, useProjectionRoute } from "../SourceContext";
import { useThreadSource } from "../useThreadSource";
import { executionSourceId, routeSourceId, sourceUrl } from "../sourceRouting";
import { useAgentSources, type EnvironmentAgent } from "../agentSources";
import { currentAgentWork } from "../AgentWork";
import { belongsToProject } from "../../shared/projects";

import { afterSheetsClose, closeTopSheet } from "../sheetHistory";
import { restoreScroll, usePageHistory } from "../usePageHistory";
import { setViewOwner } from "../viewCache";
import type { SendReceipt } from "../sendIntent";
import { useSwipeBack } from "../useSwipeBack";
import { usePullToRefresh } from "../usePullToRefresh";
import type { ComposerContext } from "../composerContext";
import { ResultsPager } from "../results";
import { initialShare, type SharedDraft } from "../Sharing";
import { OPEN_PULL } from "../PullRequests";
import { feedFilters, type FeedFilter } from "../Feed";
import { useComposerViewport } from "../useSheetViewport";
import { showLater } from "../Later";
import { useLongPress, type ScheduledSend } from "../ThreadTools";
import { notify } from "../toast";
import { sourceDraftId, saveThreadDraft as writeThreadDraft, setDraftOwner, threadDraft as readThreadDraft } from "../drafts";
import { useEffect, useLayoutEffect, useState, useRef, useMemo } from "react";
import { UserRound, Newspaper, Search, Folder, GitPullRequest } from "lucide-react";
import { api, apiInWorkspace, parse } from "../api";
import { type ThreadWork } from "../Conversation";
import type { Agent, Artifact, RunView as Run, Team } from "../../shared/types";

import { createSessionCheck, useSessionLifecycle } from "./Session";
import { createResultsLoader } from "./Results";
import { useWorkspaceData, useWorkspaceEvents, type Bootstrap } from "./WorkspaceData";

export const tabs = [
  { id: "feed", label: "Feed", icon: Newspaper },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "Your profile", icon: UserRound },
];
// Links and bookmarks from earlier layouts keep working. Later (Saved,
// Reminders, Scheduled) now lives on your profile.
const legacyPages: Record<string, { tab: string; filter?: FeedFilter }> = {
  running: { tab: "feed", filter: "working" },
  saved: { tab: "profile" },
  later: { tab: "profile" },
  personal: { tab: "profile" },
};
function initialPage() {
  const params = new URLSearchParams(location.search);
  if (params.has("social") || params.get("filter") === "social")
    return { tab: "profile" };
  const page = params.get("page") || "";
  if (tabs.some((t) => t.id === page)) return { tab: page };
  if (legacyPages[page]) return legacyPages[page];
  return { tab: params.has("folder") ? "profile" : "feed" };
}
function initialFilter(): FeedFilter {
  const params = new URLSearchParams(location.search);
  const value = params.get("filter");
  // Older "needs" links land on Done, under the Needs you stack.
  return feedFilters.some((f) => f.id === value)
    ? (value as FeedFilter)
    : initialPage().filter || "done";
}
export function useAppController() {
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("connect")) return;
    url.searchParams.delete("connect");
    history.replaceState(
      history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, []);
  const [sharedDraft, setSharedDraft] = useState<SharedDraft>(initialShare);
  const [returnTo, setReturnTo] = useState(
    new URLSearchParams(location.search).has("connect") ? "create" : "",
  );
  const [reviewTarget, setReviewTarget] = useState<{
    team?: string;
    folder?: string;
  } | null>(null);
  const [teamPreset, setTeamPreset] = useState<string | undefined>();
  const [returnToTeamDirectory, setReturnToTeamDirectory] = useState(false);
  const [environmentToOpen, setEnvironmentToOpen] = useState("");
  const [environmentSetupProvider, setEnvironmentSetupProvider] = useState("");
  const [shareAgent, setShareAgent] = useState<string | undefined>();
  useEffect(() => {
    sessionStorage.setItem("loop-share", JSON.stringify(sharedDraft));
  }, [sharedDraft]);
  const [session, setSession] = useState<any>(undefined),
    [data, setData] = useState<Bootstrap>({
      agents: [],
      connections: [],
      folders: [],
    }),
    [tab, setTab] = useState(() => initialPage().tab),
    [feedFilter, setFeedFilter] = useState<FeedFilter>(initialFilter),
    [feedHomeKey, setFeedHomeKey] = useState(0),
    [searchScope, setSearchScope] = useState<"all" | "mine">(
      new URLSearchParams(location.search).get("page") === "personal"
        ? "mine"
        : "all",
    ),
    [sheet, setSheet] = useState(
      new URLSearchParams(location.search).has("memory")
        ? "memory"
        : new URLSearchParams(location.search).has("tools")
          ? "mcp"
          : new URLSearchParams(location.search).has("share") ||
              location.pathname === "/share"
            ? "share"
            : new URLSearchParams(location.search).has("connect")
              ? "connections"
              : "",
    ),
    [error, setError] = useState(""),
    [profile, setProfile] = useState<Agent | null>(null),
    [view, setView] = useState("all"),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | number | null>(null),
    [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState(
      sessionStorage.getItem("loop-draft-agent") || "",
    ),
    [folder, setFolder] = useState(
      new URLSearchParams(location.search).get("folder") || "",
    ),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [conversation, updateConversation] = useState<string | null>(
      new URLSearchParams(location.search).get("conversation"),
    ),
    [activeArtifact, setActiveArtifact] = useState<CardArtifact | null>(null),
    [theme, setTheme] = useState(
      localStorage.getItem("loop-theme") || "system",
    ),
    [query, setQuery] = useState("");
  const [routePreview, setRoutePreview] = useState<any>(null),
    [contextArtifact, setContextArtifact] = useState<Artifact | null>(null),
    [filingResult, setFilingResult] = useState<any>(null);
  const [teamSelection, setTeamSelection] = useState<string[]>(() =>
    (new URLSearchParams(location.search).get("teams") || "")
      .split(",")
      .filter(Boolean),
  );
  const teamKey = [...teamSelection].sort().join(",");
  const [teamMessages, setTeamMessages] = useState<Team | null>(null);
  const availableAgents = data.agents.filter((a) => !a.retired_at);
  const [messageId, setMessageId] = useState<string | null>(
    new URLSearchParams(location.search).get("message"),
  );
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerFocusRequest = useRef<number | null>(null);
  const [bootstrapOwner, setBootstrapOwner] = useState<string>();
  const [composerOptions, setComposerOptions] = useState(false);
  useEffect(() => {
    if (!composerExpanded && !conversation) setComposerOptions(false);
  }, [composerExpanded, conversation]);
  const initialAgentId = useRef(
    new URLSearchParams(location.search).get("agent"),
  );
  const [replyContext, setReplyContext] = useState<ComposerContext | null>(() =>
    parse(sessionStorage.getItem("loop-draft-context") || "", null),
  );
  const [conversationTarget, setConversationTarget] =
    useState<ComposerContext | null>(null);
  useEffect(() => {
    if (replyContext)
      sessionStorage.setItem(
        "loop-draft-context",
        JSON.stringify(replyContext),
      );
    else sessionStorage.removeItem("loop-draft-context");
  }, [replyContext]);
  useEffect(() => {
    if (replyContext && selected !== replyContext.agentId)
      setReplyContext(null);
  }, [selected]);
  const [project, setProject] = useState(
    new URLSearchParams(location.search).get("projectView") || "",
  );
  // The pull request open in the Pull requests tab: owner/repo/number.
  const [pull, setPull] = useState(
    new URLSearchParams(location.search).get("pull") || "",
  );
  const [folderChoice, setFolderChoice] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("folder") ?? undefined,
  );
  const [modelAgent, setModelAgent] = useState<Agent | null>(null);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState("");
  useEffect(() => {
    sessionStorage.setItem("loop-draft-agent", selected);
  }, [selected]);
  // A notice, optionally with one follow-up action (e.g. view what was scheduled).
  const [dismissNotice, setDismissNotice] = useState<
    string | { text: string; action: string; onAction: () => void }
  >("");
  const [sendNotice, setSendNotice] = useState<{
    runId: string;
    conversationId: string | null;
    agentId: string;
    agentName: string;
    steering: boolean;
  } | null>(null);
  const [archivedCard, setArchivedCard] = useState<{
    id: string;
    source: string;
    owner: string | undefined;
  } | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  useComposerViewport(
    composerRef,
    !!session?.user && !conversation && availableAgents.length > 0,
  );
  const [sendMenu, setSendMenu] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string | null>(null);
  const [newAgentPrompt, setNewAgentPrompt] = useState("");
  const [myProfile, setMyProfile] = useState<MyProfileData | null>(null);
  const [laterCard, setLaterCard] = useState<CardArtifact | null>(null);
  const [threadNotice, setThreadNotice] = useState("");
  // The open thread's current work, so a send can say what it will do.
  const [threadWork, setThreadWork] = useState<ThreadWork | null>(null);
  const sendPress = useLongPress(
    () => {
      if (draft.trim()) setSendMenu(true);
    },
    !conversation,
    { onControls: true },
  );
  const [conversationSource, setConversationSource] = useState(routeSourceId);
  const actionSource = conversation ? conversationSource : executionSourceId();
  const threadApi = useMemo(
    () =>
      ((path, body, method, signal) =>
        apiInWorkspace(path, actionSource, body, method, signal)) as typeof api,
    [actionSource],
  );
  const threadSource = useThreadSource(
    conversation ? conversationSource : null,
    session?.user?.id,
  );
  const threadData =
    conversation && conversationSource !== executionSourceId()
      ? threadSource.data
      : data;
  const composerData = threadData || {
    agents: [],
    connections: [],
    folders: [],
    teams: [],
  };
  const threadIdentity = JSON.stringify([
    session?.user?.id,
    actionSource,
    conversation,
  ]);
  const composerIdentityRef = useRef(threadIdentity);
  composerIdentityRef.current = threadIdentity;
  const navigationGeneration = useRef(0);
  const viewIdentity = `${threadIdentity}:${navigationGeneration.current}`;
  const threadIdentityRef = useRef(viewIdentity);
  threadIdentityRef.current = viewIdentity;
  const draftId = (id: string, source = actionSource) =>
    sourceDraftId(id, source);
  const threadDraft = (id: string) => readThreadDraft(draftId(id));
  const saveThreadDraft = (
    id: string,
    text: string,
    files: UploadedFile[],
    owner = session?.user?.id,
  ) => writeThreadDraft(draftId(id), text, files, owner);
  const globalComposer = useRef({
    selected,
    replyContext,
    contextArtifact,
    folderChoice,
  });
  function setConversation(
    id: string | null,
    message?: string,
    source = executionSourceId(),
  ) {
    if (!conversation && id)
      globalComposer.current = {
        selected,
        replyContext,
        contextArtifact,
        folderChoice,
      };
    if (source !== conversationSource) {
      setReplyContext(null);
      setContextArtifact(null);
    }
    if (id !== conversation || source !== conversationSource) {
      navigationGeneration.current++;
      composerFocusRequest.current = null;
      threadIdentityRef.current = "";
      setModelAgent(null);
      setComposerOptions(false);
      setSendMenu(false);
      setScheduleAt(null);
      if (sheet === "pi-active") setSheet("");
      setThreadNotice("");
      setThreadWork(null);
      setConversationTarget(null);
    }
    setConversationSource(source);
    setMessageId(message || null);
    updateConversation(id);
    if (id) {
      const url = new URL(location.href);
      url.searchParams.set("conversation", id);
      if (source) url.searchParams.set("source", source);
      else url.searchParams.delete("source");
      url.searchParams.delete("workspace");
      if (message) url.searchParams.set("message", message);
      else url.searchParams.delete("message");
      history.replaceState(history.state, "", url.pathname + url.search);
    } else {
      const team =
        teamSelection.length === 1
          ? data.teams?.find((t) => t.id === teamSelection[0])
          : undefined;
      // Closing a conversation must leave an unsent reply with its recipient.
      if (!draft.trim() && !attachments.length) {
        if (profile) setSelected(profile.id);
        else if (team) setSelected(team.manager_id);
      }
      const url = new URL(location.href);
      url.searchParams.delete("conversation");
      if (conversationSource !== executionSourceId()) {
        const previous = globalComposer.current;
        setSelected(previous.selected);
        setReplyContext(previous.replyContext);
        setContextArtifact(previous.contextArtifact);
        setFolderChoice(previous.folderChoice);
      }
      if (executionSourceId())
        url.searchParams.set("source", executionSourceId());
      else url.searchParams.delete("source");
      url.searchParams.delete("workspace");
      url.searchParams.delete("message");
      history.replaceState(history.state, "", url.pathname + url.search);
    }
  }
  function focusRequestedComposer() {
    if (composerFocusRequest.current !== navigationGeneration.current) return;
    const input = document.querySelector<HTMLTextAreaElement>("#composer");
    input?.focus();
    if (input && document.activeElement === input)
      composerFocusRequest.current = null;
  }
  useLayoutEffect(() => {
    // A frame callback can run before React reveals the input. Finish an
    // explicit focus request after commit, without focusing on other updates.
    if (composerExpanded) focusRequestedComposer();
  });
  function focusComposer() {
    composerFocusRequest.current = navigationGeneration.current;
    setComposerExpanded(true);
    requestAnimationFrame(focusRequestedComposer);
  }
  function startChat() {
    setFolder(projectFilter);
    setNewAgentPrompt("");
    setSheet("create");
  }
  function openAgentChat(agent: Agent) {
    setSelected(agent.id);
    setFolder(agent.folder_id || "");
    setFolderChoice(undefined);
    setReplyContext(null);
    afterSheetsClose(focusComposer);
  }
  // Focus a thread's composer once its sheet has opened, but only if that
  // thread is still open; a quick close must not expand the global composer.
  const openConversation = useRef(conversation);
  openConversation.current = conversation;
  function focusThreadComposer(id: string) {
    setTimeout(() => {
      if (openConversation.current === id) focusComposer();
    }, 350);
  }
  // "Ask an agent" on a pull request starts a new message about it; your
  // unsent draft is kept and the request is added after it.
  function askAboutPull(text: string) {
    setReplyContext(null);
    setContextArtifact(null);
    setDraft((current) =>
      current.trim() ? current.trimEnd() + "\n\n" + text : text,
    );
    focusComposer();
  }
  // A PR card's "Open in Pull requests" leaves its thread for the tab.
  const openPullRef = useRef((_key: string) => {});
  openPullRef.current = (key: string) => {
    if (conversation) setConversation(null);
    setActiveArtifact(null);
    setProfile(null);
    setView("all");
    setTab("pulls");
    setPull(key);
  };
  useEffect(() => {
    const open = (e: Event) => {
      const key = (e as CustomEvent<unknown>).detail;
      if (typeof key === "string") openPullRef.current(key);
    };
    window.addEventListener(OPEN_PULL, open);
    return () => window.removeEventListener(OPEN_PULL, open);
  }, []);
  function collapseComposer() {
    composerFocusRequest.current = null;
    document.querySelector<HTMLTextAreaElement>("#composer")?.blur();
    setComposerExpanded(false);
    setComposerOptions(false);
  }
  // A tapped notification opens its link in this window: a thread at its
  // message, or a result. Any other link loads normally.
  const openLink = useRef((_url: URL) => {});
  openLink.current = (url: URL) => {
    if (
      !session?.user ||
      url.searchParams.has("checkout") ||
      url.searchParams.has("verification")
    ) {
      location.assign(url.href);
      return;
    }
    const target = url.searchParams.get("conversation");
    const artifact = url.searchParams.get("artifact");
    const story = url.searchParams.get("social");
    if (story) {
      setProfile(null);
      setConversation(null);
      setTab("profile");
      // Social reads the story from the address, as it does on a cold open.
      history.replaceState(null, "", url.pathname + url.search);
      window.dispatchEvent(new Event("loop-social-open"));
      window.dispatchEvent(new Event("loop-refresh"));
    } else if (target) {
      setProfile(null);
      setConversation(
        target,
        url.searchParams.get("message") || undefined,
        routeSourceId(url.search),
      );
    } else if (artifact)
      void api<Artifact>(`/artifacts/${artifact}`)
        .then((item) => void open(item))
        .catch((e) => setError(e.message));
    else location.assign(url.href);
  };
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const received = (event: MessageEvent) => {
      if (event.data?.type !== "loop-open") return;
      const url = new URL(String(event.data.url), location.origin);
      if (url.origin === location.origin) openLink.current(url);
    };
    navigator.serviceWorker.addEventListener("message", received);
    navigator.serviceWorker.startMessages?.();
    return () =>
      navigator.serviceWorker.removeEventListener("message", received);
  }, []);
  /** Later at a section (Scheduled, Reminders), highlighting one item. */
  function openLater(section: "scheduled" | "reminders", focusId?: string) {
    showLater(section, focusId);
    setConversation(null);
    setProfile(null);
    setTab("profile");
  }
  const showScheduled = (focusId?: string) => openLater("scheduled", focusId);
  // Later still belongs to a workspace page. Carry the destination through a
  // toast so viewing a remote reminder cannot silently open the local list.
  function openSourceLater(
    section: "scheduled" | "reminders",
    focusId: string | undefined,
    source: string,
  ) {
    if (source === executionSourceId()) return openLater(section, focusId);
    const url = new URL(sourceUrl(source), location.origin);
    url.searchParams.set("page", "profile");
    url.searchParams.set("later", section);
    if (focusId) url.searchParams.set("laterItem", focusId);
    location.assign(url.pathname + url.search);
  }
  useEffect(() => {
    if (!session?.user) return;
    const url = new URL(location.href);
    const section = url.searchParams.get("later");
    if (section !== "scheduled" && section !== "reminders") return;
    openLater(section, url.searchParams.get("laterItem") || undefined);
    const current = new URL(location.href);
    current.searchParams.delete("later");
    current.searchParams.delete("laterItem");
    history.replaceState(history.state, "", current.pathname + current.search);
  }, [session?.user?.id]);

  /**
   * A message's text and files added to a draft. Nothing already in the draft
   * is replaced: the text follows it, and files not already attached are
   * added (up to the per-message limit, which the caller is told about).
   */
  function mergeDraft(
    current: { text: string; files: UploadedFile[] },
    text: string,
    files: UploadedFile[],
  ) {
    const added = files.filter(
      (file) => !current.files.some((f) => f.id === file.id),
    );
    const merged = [...current.files, ...added].slice(0, MAX_MESSAGE_FILES);
    return {
      text: current.text.trim() ? `${current.text.trimEnd()}\n\n${text}` : text,
      files: merged,
      dropped: current.files.length + added.length - merged.length,
    };
  }
  /**
   * Put a message back into the open composer, with its files. It reads the
   * live draft: an Undo can call this long after the render that made it.
   */
  function restoreToComposer(text: string, files: UploadedFile[]) {
    const next = mergeDraft(
      { text: draftRef.current, files: attachmentsRef.current },
      text,
      files,
    );
    draftRef.current = next.text;
    setDraft(next.text);
    attachmentsRef.current = next.files;
    setAttachments(next.files);
    if (next.dropped) notifyDropped(next.dropped);
    focusComposer();
  }
  // Only a copy (a scheduled message, which stays where it is) can overflow:
  // a queued message is left queued when its files would not fit.
  const notifyDropped = (count: number) =>
    notify({
      text: `${count} file${count === 1 ? "" : "s"} did not fit in the draft (a message holds ${MAX_MESSAGE_FILES}). The original still has ${count === 1 ? "it" : "them"}.`,
      tone: "error",
    });
  /**
   * Take a queued message back into the open composer. The server cancels it
   * only if its files fit beside the draft's, so nothing is lost either way.
   */
  async function withdrawToComposer(runId: string) {
    const identity = threadIdentity;
    const owner = session?.user?.id;
    const key = draftKey;
    const held = await threadApi<{
      input: string;
      attachments: UploadedFile[];
    }>(`/runs/${runId}/withdraw`, {
      draftAttachmentIds: attachmentsRef.current.map((file) => file.id),
    });
    const visible =
      owner === ownerRef.current && identity === composerIdentityRef.current;
    const current = visible
      ? { text: draftRef.current, files: attachmentsRef.current }
      : readThreadDraft(key, owner);
    // Cancellation has already succeeded. Preserve every returned attachment,
    // even if newer edits filled the draft while the response was in flight.
    const next = {
      text: current.text.trim()
        ? `${current.text.trimEnd()}\n\n${held.input}`
        : held.input,
      files: [
        ...current.files,
        ...held.attachments.filter(
          (file) => !current.files.some((f) => f.id === file.id),
        ),
      ],
    };
    writeThreadDraft(key, next.text, next.files, owner);
    if (visible) {
      draftRef.current = next.text;
      attachmentsRef.current = next.files;
      setDraft(next.text);
      setAttachments(next.files);
      focusComposer();
    }
  }
  /**
   * Put a message back into a draft for its agent, text and files: a
   * scheduled message that could not be sent, or one taken back from the
   * queue. Nothing is sent.
   */
  function restoreDraft(item: {
    agentId: string;
    conversationId: string | null;
    text: string;
    files: UploadedFile[];
  }) {
    if (item.conversationId && item.conversationId === conversation)
      return restoreToComposer(item.text, item.files);
    if (item.conversationId) {
      const saved = threadDraft(item.conversationId);
      const next = mergeDraft(saved, item.text, item.files);
      saveThreadDraft(item.conversationId, next.text, next.files);
      if (next.dropped) notifyDropped(next.dropped);
      setSelected(item.agentId);
      setConversation(item.conversationId);
      focusThreadComposer(item.conversationId);
      return;
    }
    setConversation(null);
    setReplyContext(null);
    setContextArtifact(null);
    setSelected(item.agentId);
    setFolderChoice(undefined);
    afterSheetsClose(() => restoreToComposer(item.text, item.files));
  }
  const draftFromScheduled = (item: ScheduledSend) =>
    restoreDraft({
      agentId: item.agent_id,
      conversationId: item.conversation_id,
      text: item.input,
      files: item.attachments || [],
    });
  // Replies happen inside the thread: open it (at the quoted message) instead
  // of leaving it, so reading and answering stay in one place.
  function beginReply(
    context: ComposerContext,
    text?: string,
    source = actionSource,
  ) {
    const switching =
      !!context.conversationId &&
      (conversation !== context.conversationId ||
        source !== conversationSource);
    // Opening a thread from another source clears the composer's context, so
    // open it before setting the reply.
    if (switching)
      setConversation(context.conversationId, context.messageId, source);
    setActiveArtifact(null);
    setContextArtifact(null);
    setReplyContext(context);
    setSelected(context.agentId);
    setFolderChoice(undefined);
    setComposerError("");
    const url = new URL(location.href);
    url.searchParams.delete("artifact");
    history.replaceState(history.state, "", url.pathname + url.search);
    const previous =
      text ??
      ((context.messageId &&
        sessionStorage.getItem(
          "loop-message-reply-" + draftId(context.messageId, source),
        )) ||
        (context.artifactId &&
          sessionStorage.getItem(
            "loop-result-reply-" + draftId(context.artifactId, source),
          )) ||
        undefined);
    // Opening another thread loads that thread's own draft; seed it first.
    if (switching) {
      const key = draftId(context.conversationId, source);
      if (previous !== undefined && !readThreadDraft(key).text)
        writeThreadDraft(key, previous, [], session?.user?.id);
    } else if (text !== undefined) setDraft(text);
    else if (!draft.trim() && previous) setDraft(previous);
    setComposerExpanded(true);
    if (switching) focusThreadComposer(context.conversationId);
    else if (context.conversationId) focusComposer();
    else afterSheetsClose(focusComposer);
  }
  const replyRequest = useRef(0);
  async function replyToArtifact(item: CardArtifact) {
    const source = item.sourceId ?? executionSourceId(),
      owner = ownerRef.current,
      ticket = ++replyRequest.current;
    if (item.cardOwner && item.cardOwner !== owner) return;
    const current = () =>
      owner === ownerRef.current &&
      source === executionSourceId() &&
      ticket === replyRequest.current;
    try {
      const reader = cardReader((path) => apiInWorkspace(path, source));
      const card = item.card ? await reader.detail(item.card.id) : null;
      const original =
        card?.type === "result"
          ? cardArtifact(card, source, owner)
          : await apiInWorkspace<Artifact>(`/artifacts/${item.id}`, source);
      if (!current()) return;
      if (
        !original.agent_id ||
        !original.conversation_id ||
        parse<any>(original.metadata, {}).origin === "import"
      )
        return void open(original);
      beginReply({
        agentId: original.agent_id,
        conversationId: original.conversation_id,
        messageId: parse<any>(original.metadata, {}).messageId,
        artifactId: original.id,
        title: original.title,
        content: original.content,
      });
    } catch (error) {
      if (current()) setError((error as Error).message);
    }
  }
  function openTeamFeed(team: Team) {
    setProfile(null);
    setTab("feed");
    setView("all");
    setTeamSelection([team.id]);
    setProjectFilter("");
    if (!draft.trim() && !attachments.length) {
      setSelected(team.manager_id);
      setReplyContext(null);
      setContextArtifact(null);
    }
    afterSheetsClose(() => window.scrollTo({ top: 0, behavior: "instant" }));
  }
  function messageTeam(team: Team) {
    setReplyContext(null);
    setSelected(team.manager_id);
    setContextArtifact(null);
    if (team.conversation_id) setConversation(team.conversation_id);
    else {
      setTeamSelection([team.id]);
      focusComposer();
    }
  }
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if ((e.target as Element)?.closest?.("dialog[open]")) return;
      if (!composerRef.current?.contains(e.target as Node))
        setComposerExpanded(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  async function archiveCard(
    id: string,
    hidden = true,
    source = executionSourceId(),
  ) {
    const owner = ownerRef.current;
    try {
      await apiInWorkspace(`/results/${id}`, source, { hidden }, "PATCH");
      if (source !== executionSourceId() || owner !== ownerRef.current) return;
      setItems((old) => old.filter((item) => item.id !== id));
      setArchivedCard(hidden ? { id, source, owner } : null);
      await loadResults();
    } catch (e) {
      if (source === executionSourceId() && owner === ownerRef.current)
        setError((e as Error).message);
    }
  }
  const [searchAgent, setSearchAgent] = useState("");
  const [projectFilter, setProjectFilter] = useState(
    new URLSearchParams(location.search).get("project") || "",
  );
  const [resultsLoading, setResultsLoading] = useState(true);
  const [resultsError, setResultsError] = useState("");
  const [workspaceLoadErrors, setWorkspaceLoadErrors] = useState<Partial<Record<"bootstrap" | "runs", string>>>({});
  const workspaceLoadError = workspaceLoadErrors.bootstrap || workspaceLoadErrors.runs || "";
  const [settingsParent, setSettingsParent] = useState(false);
  const previousPage = usePageHistory(
    JSON.stringify([
      tab,
      profile?.id,
      tab === "projects" ? project : "",
      tab === "pulls" ? pull : "",
      teamKey,
    ]),
    {
      tab,
      profileId: profile?.id,
      project,
      pull,
      folder,
      view,
      teamSelection,
      projectFilter,
      query,
      conversation,
      conversationSource,
      messageId,
      activeArtifact,
    },
    session?.user?.id,
    (previous, scroll) => {
      setTab(previous.tab);
      setProfile(
        data.agents.find((agent) => agent.id === previous.profileId) || null,
      );
      setProject(previous.project);
      setPull(previous.pull || "");
      setFolder(previous.folder);
      setView(previous.view);
      setTeamSelection(previous.teamSelection);
      setProjectFilter(previous.projectFilter);
      setQuery(previous.query);
      setConversation(
        previous.conversation,
        previous.messageId || undefined,
        previous.conversationSource,
      );
      setActiveArtifact(previous.activeArtifact);
      afterSheetsClose(() => restoreScroll(scroll));
    },
  );
  // Pull down at the top of any page to refresh what it shows.
  const pullRefresh = usePullToRefresh(Boolean(session?.user), async () => {
    window.dispatchEvent(new Event("loop-refresh"));
    await changed();
  });
  useSwipeBack(Boolean(session?.user), () => {
    if (closeTopSheet() || previousPage()) return true;
    if (profile) {
      setProfile(null);
      setView("all");
    } else if (tab === "projects" && project) setProject("");
    else if (tab === "pulls" && pull) setPull("");
    else if (tab !== "feed") {
      setTab("feed");
      setView("all");
    } else return false;
    return true;
  });
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  function closeSheet() {
    if (sheet === "create") {
      setEnvironmentToOpen("");
      setEnvironmentSetupProvider("");
    }
    if (sheet === "teams" && returnToTeamDirectory) {
      setSheet("teamDirectory");
      setReturnToTeamDirectory(false);
      setReturnTo("");
      return;
    }
    setSheet(
      sheet === "create" && ["share", "workflows", "teams"].includes(returnTo)
        ? returnTo
        : sheet === "environments" && returnTo === "create"
          ? "create"
          : settingsParent
            ? "settings"
            : "",
    );
    setReturnTo("");
  }
  function openSettingsPage(page: string) {
    setSettingsParent(true);
    setSheet(page);
  }
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get("filter") === "social")
      url.searchParams.set("profileTab", "social");
    for (const [key, value] of Object.entries({
      page: tab === "feed" ? "" : tab,
      filter: tab === "feed" && feedFilter !== "done" ? feedFilter : "",
      project: projectFilter,
      teams: teamKey,
      projectView: project,
      pull: tab === "pulls" ? pull : "",
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    // Pairing and shared links keep their fragment until their owning flow
    // consumes it; persisting navigation must not discard that state.
    history.replaceState(
      history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, [tab, projectFilter, teamKey, project, feedFilter, pull]);
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);
  const [workflowSource, setWorkflowSource] = useState<string | undefined>(
    undefined,
  );
  const [filing, setFiling] = useState<CardArtifact | null>(null),
    [revision, setRevision] = useState(0);
  const [collectionRevisions, setCollectionRevisions] = useState<Partial<Record<WorkspaceCollection, number>>>({});
  const revisionFor = (collection: WorkspaceCollection) => revision + (collectionRevisions[collection] || 0);
  // Your profile and its counts; refreshed while the profile is open.
  const signedIn: string | undefined = session?.user?.id;
  const unified = useAgentSources(signedIn, { ...data, runs });
  const currentSourceName =
    unified.sources.find((source) => source.id === executionSourceId())?.name ||
    (executionSourceId() ? "Connected environment" : "This computer");
  const creationConnections = unified.connections.length
    ? unified.connections
    : data.connections.map((connection) => ({
        ...connection,
        sourceId: executionSourceId(),
        executionEnvironment: currentSourceName,
      }));
  const creationFolders = unified.folders.length
    ? unified.folders
    : data.folders.map((folder) => ({
        ...folder,
        sourceId: executionSourceId(),
      }));
  function openSourcedConversation(
    id: string,
    message?: string,
    sourceId = executionSourceId(),
  ) {
    setConversation(id, message, sourceId);
  }
  function openSourcedAgent(agent: EnvironmentAgent) {
    if ((agent.sourceId || "") !== executionSourceId()) {
      location.assign(sourceUrl(agent.sourceId || "", { agent: agent.id }));
      return;
    }
    setProfile(agent);
  }
  useEffect(() => {
    if (!signedIn) return setMyProfile(null);
    const controller = new AbortController();
    api<MyProfileData>("/me/profile", undefined, undefined, controller.signal)
      .then(setMyProfile)
      .catch(() => {});
    return () => controller.abort();
  }, [signedIn, tab === "profile" ? revision : -1]);
  // The name shown for you: your profile's, else the account's.
  const accountName: string = session?.user?.name?.trim() || "You";
  const displayName = myProfile?.display_name || accountName;
  const receiptStorageKey = `loop-send:${threadIdentity}`;
  const receiptBox = useRef<{
    key: string;
    box: { current: SendReceipt };
  } | null>(null);
  if (receiptBox.current?.key !== receiptStorageKey) {
    receiptBox.current = {
      key: receiptStorageKey,
      box: {
        current: parse<SendReceipt>(
          sessionStorage.getItem(receiptStorageKey) ||
            (actionSource === executionSourceId()
              ? sessionStorage.getItem(
                  `loop-draft-receipt:${actionSource || "laptop"}`,
                )
              : "") ||
            (!actionSource
              ? sessionStorage.getItem("loop-draft-receipt")
              : "") ||
            "",
          { signature: "", key: "" },
        ),
      },
    };
  }
  // Each in-flight continuation keeps its originating box after navigation.
  const request = receiptBox.current.box;
  const ownerRef = useRef<string | undefined>(undefined);
  ownerRef.current = session?.user?.id;
  // Drafts are read and written only for the signed-in owner.
  setDraftOwner(session?.user?.id);
  setViewOwner(session?.user?.id);
  const readSnapshot = useProjectionRead();
  const readContract = useProjectionRoute();
  const personalWorkspace = useRef(false);
  const stopWorkspaceEvents = useRef<() => void>(() => {});
  personalWorkspace.current = session?.mode === "single-user";
  const resultsPager = useRef(new ResultsPager<ResultItem>());
  const cardsPager = useRef(new CardPager());
  const resultsSelection = useRef({ key: "" });
  const resultsVisible = useRef(true);
  // Project activity and files also follow feed changes to refresh in place.
  resultsVisible.current =
    (tab === "projects" && !!project) ||
    (!!profile && ["all", "files"].includes(view));
  const lastNavTap = useRef<{ tab: string; at: number } | null>(null);
  const resultsContext = useRef("");
  resultsContext.current = JSON.stringify([
    session?.user?.id,
    executionSourceId(),
    profile?.id,
    view,
    teamKey,
    projectFilter,
  ]);
  const activeAgent =
    selected === "__route__"
      ? composerData.agents.find((a) => a.id === routePreview?.agent?.id)
      : composerData.agents.find((a) => a.id === selected) ||
        (!replyContext && !conversation
          ? availableAgents.find((a) => a.connection_id)
          : undefined);
  const selectedTeams =
    data.teams?.filter((t) => teamSelection.includes(t.id)) || [];
  const teamAgents = new Set(
    selectedTeams.flatMap((t) => [t.manager_id, ...t.members]),
  );
  const scopedAgents = availableAgents.filter(
    (a) =>
      (!projectFilter ||
        belongsToProject(a.folder_id, projectFilter, data.folders)) &&
      (!teamSelection.length || teamAgents.has(a.id)),
  );
  const scopedRuns = runs.filter(
    (r) =>
      (!teamSelection.length ||
        teamSelection.includes(parse<any>(r.payload, {}).teamId)) &&
      (!projectFilter ||
        belongsToProject(
          parse<any>(r.payload, {}).folderId,
          projectFilter,
          data.folders,
        )),
  );
  const profileWork = currentAgentWork(runs, profile?.id);
  const sentRun = runs.find((run) => run.id === sendNotice?.runId);
  // The Feed tab's badge: how many agents are working right now.
  const runningAgentCount = new Set(
    (projectFilter || teamSelection.length ? scopedRuns : unified.runs)
      .filter((r) => ["running", "pausing"].includes(r.state))
      .map(
        (r) =>
          `${"sourceId" in r ? r.sourceId || "laptop" : executionSourceId() || "laptop"}:${r.agent_id}`,
      ),
  ).size;
  const { draftKey, draftOwner, draftLoadedFor, pendingDraftSave } = useComposerDraft({
    draftId,
    conversation,
    session,
    draftRef,
    attachmentsRef,
    setDraft,
    setAttachments,
    setComposerExpanded,
    setComposerError,
    setBusy,
    setUploading,
    draft,
    attachments,
  });
  // Results are not polled while hidden; catch up when they come back.
  useEffect(() => {
    if (session?.user && resultsVisible.current) void loadResults(false, false);
  }, [tab, feedFilter, project]);
  // Inside a project the default recipient is one of that project's agents.
  useEffect(() => {
    if (tab !== "projects" || !project || conversation || draft.trim()) return;
    const current = data.agents.find((a) => a.id === selected);
    if (current && belongsToProject(current.folder_id, project, data.folders))
      return;
    const agent = availableAgents.find(
      (a) =>
        a.connection_id && belongsToProject(a.folder_id, project, data.folders),
    );
    if (agent) {
      setSelected(agent.id);
      setReplyContext(null);
      setFolderChoice(undefined);
      setFolder(project);
    }
  }, [tab, project, data.agents, conversation]);
  async function changed() {
    setRevision((v) => v + 1);
    await refresh();
  }
  function teamVisibilityChanged(team: Team) {
    setData((old) => ({
      ...old,
      teams: old.teams?.map((item) => (item.id === team.id ? team : item)),
    }));
    // Supersede any in-flight feed read so a saved preference takes effect now.
    window.dispatchEvent(new Event("loop-source-refresh"));
  }
  const check = createSessionCheck({
    setSession,
  });
  const loadResults = createResultsLoader({
    ownerRef, profile, view, teamKey, projectFilter,
    resultsContext, resultsSelection, resultsPager, cardsPager, setItems,
    setNext, setResultsLoading, setResultsError, readSnapshot, readContract,
    setRevision,
  });
  const { bootstrap, loadRuns, runsGeneration, refresh } = useWorkspaceData({
    setWorkspaceLoadErrors, ownerRef, readContract, setData, initialAgentId,
    setProfile, setTeamSelection, setRuns, loadResults,
    setBootstrapOwner, openAgentChat,
  });
  useSessionLifecycle({
    check, setError, personalWorkspace, setSession, setData,
    setItems, setRuns, setSendNotice, setWorkspaceLoadErrors, setTeamSelection,
    setArchivedCard, setComposerExpanded, setDraft, setSelected, setFolderChoice,
    setSharedDraft, setProfile, setConversation, setActiveArtifact, setContextArtifact,
    setReplyContext, setRoutePreview, setFiling, setLaterCard, setSettingsParent,
    setSheet, composerFocusRequest, setBootstrapOwner,
  });
  useWorkspaceEvents({
    session, refresh, setError, profile, view,
    teamKey, projectFilter, workspaceLoadError, setRevision, setCollectionRevisions,
    bootstrap, loadRuns, resultsVisible, loadResults,
  });
  useEffect(() => {
    localStorage.setItem("loop-theme", theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  const send = useComposerSend({
    busy,
    uploading,
    draft,
    conversation,
    conversationTarget,
    viewIdentity,
    threadIdentityRef,
    threadIdentity,
    composerIdentityRef,
    draftRef,
    attachmentsRef,
    attachments,
    setNewAgentPrompt,
    setFolder,
    projectFilter,
    project,
    setSheet,
    replyContext,
    contextArtifact,
    setError,
    threadApi,
    setFilingResult,
    setFiling,
    setDraft,
    changed,
    selected,
    routePreview,
    folder,
    setBusy,
    setRoutePreview,
    activeAgent,
    setComposerError,
    ownerRef,
    composerData,
    profile,
    teamSelection,
    folderChoice,
    draftId,
    request,
    receiptStorageKey,
    pendingDraftSave,
    draftKey,
    openSourceLater,
    actionSource,
    setAttachments,
    setReplyContext,
    collapseComposer,
    runsGeneration,
    setRuns,
    setSendNotice,
    saveThreadDraft,
    setContextArtifact,
    withdrawToComposer,
    refresh,
    setThreadNotice,
    setDismissNotice,
  });
  function openCard(item: Artifact) {
    setFolderChoice(undefined);
    if (item.conversation_id) {
      setSelected(item.agent_id || "");
      setConversation(
        item.conversation_id,
        parse<any>(item.metadata, {}).messageId,
      );
    } else void open(item);
  }
  const openRequest = useRef(0);
  async function open(item: CardArtifact) {
    setFolderChoice(undefined);
    const owner = ownerRef.current,
      source = item.sourceId ?? executionSourceId(),
      ticket = ++openRequest.current;
    if (item.cardOwner && item.cardOwner !== owner) return;
    const current = () =>
      owner === ownerRef.current &&
      source === executionSourceId() &&
      ticket === openRequest.current;
    const reader = cardReader((path, signal) =>
      apiInWorkspace(path, source, undefined, undefined, signal),
    );
    try {
      try {
        const card = await reader.detail("a:" + item.id);
        if (card.type !== "result") throw new Error("Expected a result card");
        item = cardArtifact(card, source, owner);
      } catch (error) {
        // Files and retained legacy entrypoints can open artifacts outside the
        // public selections. A card itself must always use its typed detail.
        if (item.card || (error as { status?: number }).status !== 404)
          throw error;
        item = await apiInWorkspace<Artifact>(`/artifacts/${item.id}`, source);
      }
    } catch (e) {
      if (current()) setError((e as Error).message);
      return;
    }
    if (!current()) return;
    setContextArtifact(item);
    if (item.agent_id) setSelected(item.agent_id);
    if (item.kind === "workflow") {
      const meta = parse<any>(item.metadata, {});
      setWorkflowId(meta.workflowId);
      setWorkflowSource(item.content);
      setSheet("workflows");
      return;
    }
    setActiveArtifact(item);
  }
  useEffect(() => {
    const artifact = new URLSearchParams(location.search).get("artifact");
    if (session?.user && artifact)
      void api<Artifact>(`/artifacts/${artifact}`)
        .then((item) => void open(item))
        .catch((e) => setError(e.message));
  }, [session?.user?.id]);
  useEffect(() => {
    if (!profile) return;
    setView(sessionStorage.getItem("loop-agent-tab-" + profile.id) || "all");
    if (!draft.trim()) {
      setSelected(profile.id);
      setFolderChoice(undefined);
      setFolder(profile.folder_id || "");
    }
  }, [profile?.id]);
  useEffect(() => {
    if (
      conversation ||
      profile ||
      draft.trim() ||
      attachments.length ||
      replyContext
    )
      return;
    const target =
      scopedAgents.find((a) => a.id === selected) ||
      scopedAgents.find((a) => a.connection_id);
    if (target) {
      setSelected(target.id);
      setFolderChoice(undefined);
      setFolder(target.folder_id || "");
    }
  }, [projectFilter, teamKey, data.agents, conversation]);
  return {
    bootstrapOwner, setBootstrapOwner, composerOptions, setComposerOptions,
    composerFocusRequest, startChat,
    tab, lastNavTap, setFeedFilter, setFeedHomeKey, setTab,
    setProfile, setView, displayName, runningAgentCount, session,
    error, check, conversation, data, projectFilter,
    setProjectFilter, replyContext, runs, activeAgent, conversationTarget,
    folderChoice, contextArtifact, selected, routePreview, busy,
    uploading, draft, send, sendPress, composerData,
    availableAgents, composerRef, composerExpanded, sendNotice, sentRun,
    setSelected, setConversation, setSendNotice, attachments, setContextArtifact,
    setFolderChoice, setFolder, focusComposer, setReplyContext, collapseComposer,
    setDraft, setComposerExpanded, setAttachments, composerError, setComposerError,
    threadIdentity, setUploading, viewIdentity, threadIdentityRef, attachmentsRef,
    setSheet, setModelAgent, setSendMenu, threadWork, threadNotice,
    setThreadNotice, beginReply, open, replyToArtifact, archiveCard,
    setLaterCard, setFiling, ownerRef, changed, setError,
    openCard, resultsError, items, loadResults, resultsLoading,
    profile, view, teamSelection, profileWork, next,
    setTeamSelection, setProject, sheet, pullRefresh, workspaceLoadError,
    refresh, unified, stopWorkspaceEvents, previousPage, currentSourceName,
    messageTeam, openTeamFeed, project, teamVisibilityChanged, setData,
    bootstrap, setTeamMessages, scopedAgents, openSourcedAgent, feedHomeKey,
    feedFilter, teamKey, revisionFor, openSourcedConversation, focusThreadComposer,
    showScheduled, openLater, askAboutPull, scopedRuns, draftFromScheduled,
    setActiveArtifact, revision, accountName, myProfile, setMyProfile,
    setSettingsParent, searchAgent, searchScope, pull, setPull,
    setWorkflowId, setWorkflowSource, setReviewTarget, dismissNotice, setDismissNotice,
    archivedCard, setArchivedCard, settingsParent, openSettingsPage, theme,
    setTheme, draftOwner, draftLoadedFor, draftRef, setSharedDraft,
    setRoutePreview, setSession, setItems, setRuns, setEditError,
    setSearchAgent, setSearchScope, sendMenu, setScheduleAt, scheduleAt,
    laterCard, openSourceLater, closeSheet, sharedDraft, shareAgent,
    setReturnTo, setShareAgent, workflowId, workflowSource, setRevision,
    returnTo, folder, newAgentPrompt, environmentToOpen, environmentSetupProvider,
    creationConnections, creationFolders, setEnvironmentToOpen, setEnvironmentSetupProvider, setNewAgentPrompt,
    reviewTarget, teamPreset, setTeamPreset, setReturnToTeamDirectory, teamMessages,
    actionSource, threadSource, modelAgent, editBusy, setEditBusy,
    editError, threadData, conversationSource, messageId, setThreadWork,
    setConversationTarget, threadDraft, restoreToComposer, withdrawToComposer, activeArtifact,
    filing, filingResult, setFilingResult, personalWorkspace, setWorkspaceLoadErrors,
    setCollectionRevisions, loadRuns, resultsVisible,
  };
}

export type AppModel = ReturnType<typeof useAppController>;
