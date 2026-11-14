import {
  useAppNavigation,
  replaceConversationLocation,
  type AppNavigationInitial,
} from "./Navigation";
import { ArtifactId } from "../../shared/contract-ids.js";
import { RunId } from "../../shared/contract-ids.js";
import { useFeedBadge } from "../useFeedBadge";
import { useComposerDraft, useComposerSend } from "./Composer";
import {
  workspaceApi,
  type ClientRouteContract,
  type RouteInput,
} from "../../shared/workspace-api";
import { capabilities as shellCapabilities } from "../capabilities";
import { composerBlockReason } from "../sourceAvailability";
import { type WorkspaceCollection } from "../../shared/workspace-events";
import { resultTarget, type ResultAction } from "../card-actions";
import { renderArtifactReadNotice, useArtifactReads } from "./ArtifactReads";

import { CollectionReadNotice, useProjectionQuery } from "../CollectionRead";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../../shared/uploads";
import { useThreadSource } from "../useThreadSource";
import { executionSourceId, sourceUrl } from "../sourceRouting";
import { useAgentSources, type EnvironmentAgent } from "../agentSources";
import { currentAgentWork } from "../AgentWork";
import { belongsToProject } from "../../shared/projects";

import { afterSheetsClose, closeTopSheet } from "../sheetHistory";
import { restoreScroll, usePageHistory } from "../usePageHistory";
import { viewGeneration } from "../viewCache";
import {
  sessionDraft,
  emptySharedDraft,
  type SharedDraft,
  type WorkspaceComposerDraft,
} from "../workspace-drafts";
import type { SendReceipt } from "../sendIntent";
import { readSendReceipt, sendReceiptKey } from "../sendReceiptStore";
import { useSwipeBack } from "../useSwipeBack";
import { usePullToRefresh } from "../usePullToRefresh";
import {
  quotesReply,
  type ComposerContext,
  type LatestAgentMessage,
} from "../composerContext";
import { OPEN_PULL } from "../PullRequests";
import { useComposerViewport } from "../useSheetViewport";
import { showLater } from "../Later";
import { useLongPress, type ScheduledSend } from "../ThreadTools";
import { notify } from "../toast";
import {
  sourceDraftId,
  saveThreadDraft as writeThreadDraft,
  threadDraft as readThreadDraft,
} from "../drafts";
import { useEffect, useLayoutEffect, useState, useRef, useMemo } from "react";
import { parse } from "../json";
import { callRoute } from "../api";
import { type ThreadWork } from "../Conversation";
import type {
  Agent,
  Artifact,
  Folder,
  RunView as Run,
  Team,
} from "../../shared/types";

import {
  createSessionCheck,
  useSessionLifecycle,
  useOwnerSession,
} from "./Session";
import { useResultsLoader } from "./Results";
import {
  useWorkspaceData,
  useWorkspaceEvents,
  type Bootstrap,
} from "./WorkspaceData";

export function useAppController(seed?: AppNavigationInitial) {
  const {
    initial,
    tab,
    setTab,
    feedFilter,
    setFeedFilter,
    sheet,
    setSheet,
    folder,
    setFolder,
    conversation,
    updateConversation,
    messageId,
    setMessageId,
    teamSelection,
    setTeamSelection,
    project,
    setProject,
    pull,
    setPull,
    conversationSource,
    setConversationSource,
    returnTo,
    setReturnTo,
    projectFilter,
    setProjectFilter,
  } = useAppNavigation(seed);
  const [sharedDraft, setSharedDraft] = useState<SharedDraft>(
    initial.sharedDraft,
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
  const { session, setSession, ownerRef } = useOwnerSession();
  const [data, setData] = useState<Bootstrap>({
      agents: [],
      connections: [],
      folders: [],
    }),
    [feedHomeKey, setFeedHomeKey] = useState(0),
    [searchScope, setSearchScope] = useState<"all" | "mine">("all"),
    [error, setError] = useState(""),
    [profile, setProfile] = useState<Agent | null>(null),
    [view, setView] = useState("all"),
    [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [activeArtifact, setActiveArtifact] = useState<ResultAction | null>(null),
    [theme, setTheme] = useState(
      localStorage.getItem("loop-theme") || "system",
    ),
    [query, setQuery] = useState("");
  const [routePreview, setRoutePreview] = useState<any>(null),
    [contextArtifact, setContextArtifact] = useState<ResultAction | null>(null),
    [filingResult, setFilingResult] = useState<any>(null);
  const teamKey = [...teamSelection].sort().join(",");
  const [teamMessages, setTeamMessages] = useState<Team | null>(null);
  const availableAgents = data.agents.filter((a) => !a.retired_at);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerFocusRequest = useRef<number | null>(null);
  const [bootstrapOwner, setBootstrapOwner] = useState<string>();
  const [composerOptions, setComposerOptions] = useState(false);
  useEffect(() => {
    if (!composerExpanded && !conversation) setComposerOptions(false);
  }, [composerExpanded, conversation]);
  const initialAgentId = useRef(initial.agentId);
  const [replyContext, setReplyContext] = useState<ComposerContext | null>(
    null,
  );
  const [conversationTarget, setConversationTarget] =
    useState<ComposerContext | null>(null);
  const [latestAgentMessage, setLatestAgentMessage] =
    useState<LatestAgentMessage | null>(null);
  useEffect(() => {
    if (replyContext && selected !== replyContext.agentId)
      setReplyContext(null);
  }, [selected]);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  function editFolder(id: string) {
    const target = data.folders.find((folder) => folder.id === id);
    if (!target) return;
    setEditingFolder(target);
    setSheet("folder-edit");
  }
  const [folderChoice, setFolderChoice] = useState<string | undefined>(
    initial.folderChoice,
  );
  const [modelAgent, setModelAgent] = useState<Agent | null>(null);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState("");
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
  const [laterCard, setLaterCard] = useState<ResultAction | null>(null);
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
  const actionSource = conversation ? conversationSource : executionSourceId();
  const threadApi = useMemo(
    () =>
      <C extends ClientRouteContract>(
        contract: C,
        input: RouteInput<C>,
        signal?: AbortSignal,
      ) =>
        callRoute(contract, input, actionSource, signal),
    [actionSource],
  );
  const threadSource = useThreadSource(
    conversation ? conversationSource : null,
    session?.user?.id,
  );
  const composerUnavailable = composerBlockReason(
    actionSource,
    actionSource === executionSourceId()
      ? shellCapabilities
      : threadSource.capabilities,
    draft,
    selected,
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
  const shellDraftSource = executionSourceId();
  const draftGeneration = viewGeneration();
  const composerStorage = useMemo(
    () =>
      sessionDraft<WorkspaceComposerDraft>(
        session?.user?.id,
        shellDraftSource,
        "composer",
      ),
    [session?.user?.id, shellDraftSource, draftGeneration],
  );
  const shareStorage = useMemo(
    () =>
      sessionDraft<SharedDraft>(session?.user?.id, shellDraftSource, "share"),
    [session?.user?.id, shellDraftSource, draftGeneration],
  );
  const draftScope = JSON.stringify([composerStorage.key, draftGeneration]);
  const [hydratedDraftScope, setHydratedDraftScope] = useState("");
  const incomingShareClaimed = useRef(false);
  useLayoutEffect(() => {
    if (!session?.user?.id) return;
    const saved = composerStorage.read();
    const firstOwner = !incomingShareClaimed.current;
    const incoming = firstOwner && initial.shareRequested;
    incomingShareClaimed.current = true;
    const restored = {
      selected: saved?.selected || "",
      replyContext: saved?.replyContext || null,
      folderChoice:
        saved?.folderChoice ?? (firstOwner ? initial.folderChoice : undefined),
      contextArtifact: null,
    };
    setSelected(restored.selected);
    setReplyContext(restored.replyContext);
    setFolderChoice(restored.folderChoice);
    setContextArtifact(null);
    setRoutePreview(null);
    globalComposer.current = restored;
    setSharedDraft(
      incoming
        ? initial.sharedDraft
        : shareStorage.read() || emptySharedDraft(),
    );
    setHydratedDraftScope(draftScope);
  }, [composerStorage, shareStorage, draftScope]);
  useEffect(() => {
    // The hydration render's stale values cannot overwrite the newly selected
    // owner's slot. Thread controls are stored by their existing thread owner.
    if (hydratedDraftScope !== draftScope || conversation) return;
    composerStorage.write({ selected, replyContext, folderChoice });
  }, [
    composerStorage,
    draftScope,
    hydratedDraftScope,
    conversation,
    selected,
    replyContext,
    folderChoice,
  ]);
  useEffect(() => {
    if (hydratedDraftScope === draftScope) shareStorage.write(sharedDraft);
  }, [shareStorage, draftScope, hydratedDraftScope, sharedDraft]);
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
      setLatestAgentMessage(null);
    }
    setConversationSource(source);
    setMessageId(message || null);
    updateConversation(id);
    if (id) {
      replaceConversationLocation(source, id, message);
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
      if (conversationSource !== executionSourceId()) {
        const previous = globalComposer.current;
        setSelected(previous.selected);
        setReplyContext(previous.replyContext);
        setContextArtifact(previous.contextArtifact);
        setFolderChoice(previous.folderChoice);
      }
      replaceConversationLocation(executionSourceId(), null);
    }
  }
  function focusRequestedComposer() {
    if (!ownerRef.current) return;
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
    if (!ownerRef.current) return;
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
    const section = initial.later;
    if (section !== "scheduled" && section !== "reminders") return;
    openLater(section, initial.laterItem);
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
    const held = await threadApi(workspaceApi.runWithdraw, {
      params: { id: RunId.parse(runId) },
      body: {
        draftAttachmentIds: attachmentsRef.current.map((file) =>
          ArtifactId.parse(file.id),
        ),
      },
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
    // Opening another thread loads that thread's own draft; seed it first.
    if (switching) {
      const key = draftId(context.conversationId, source);
      if (text !== undefined && !readThreadDraft(key).text)
        writeThreadDraft(key, text, [], session?.user?.id);
    } else if (text !== undefined) setDraft(text);
    setComposerExpanded(true);
    if (switching) focusThreadComposer(context.conversationId);
    else if (context.conversationId) focusComposer();
    else afterSheetsClose(focusComposer);
  }
  const artifactReads = useArtifactReads({
    ownerRef,
    initialArtifact: initial.artifactId,
    onStartOpen: () => setFolderChoice(undefined),
    onOpen: (item) => {
      setContextArtifact(item);
      const agentId = resultTarget(item).agent_id;
      if (agentId) setSelected(agentId);
      setActiveArtifact(item);
    },
    onReply: (context) => beginReply(context),
  });
  const { open, replyToArtifact } = artifactReads;
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
      await callRoute(
        workspaceApi.resultUpdate,
        { params: { id: ArtifactId.parse(id) }, body: { hidden } },
        source,
      );
      if (source !== executionSourceId() || owner !== ownerRef.current) return;
      setItems((old) => old.filter((item) => resultTarget(item).id !== id));
      setArchivedCard(hidden ? { id, source, owner } : null);
      await loadResults();
    } catch (e) {
      if (source === executionSourceId() && owner === ownerRef.current)
        setError((e as Error).message);
    }
  }
  const [searchAgent, setSearchAgent] = useState("");
  const [workspaceLoadErrors, setWorkspaceLoadErrors] = useState<
    Partial<Record<"bootstrap" | "runs", string>>
  >({});
  const workspaceLoadError =
    workspaceLoadErrors.bootstrap || workspaceLoadErrors.runs || "";
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
      sheet === "create" && ["share", "teams"].includes(returnTo)
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
  const [filing, setFiling] = useState<ResultAction | null>(null),
    [revision, setRevision] = useState(0);
  const [collectionRevisions, setCollectionRevisions] = useState<
    Partial<Record<WorkspaceCollection, number>>
  >({});
  const revisionFor = (collection: WorkspaceCollection) =>
    revision + (collectionRevisions[collection] || 0);
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
  const myProfileRead = useProjectionQuery(
    workspaceApi.personalProfile,
    {},
    {
      source: executionSourceId(),
      enabled: !!signedIn,
      revision: tab === "profile" ? revision : -1,
    },
  );
  const myProfile = myProfileRead.data ?? null;
  const setMyProfile = myProfileRead.replace;
  // The name shown for you: your profile's, else the account's.
  const accountName: string = session?.user?.name?.trim() || "You";
  const displayName = myProfile?.display_name || accountName;
  // A pending receipt survives restart, a new tab and auth expiry: it is kept
  // in owner/source/thread-scoped durable storage, not sessionStorage (which
  // Session clears on expiry), so a re-send repeats the same idempotency key.
  const receiptStorageKey =
    session?.user?.id != null
      ? sendReceiptKey(session.user.id, actionSource, conversation)
      : "";
  const receiptBox = useRef<{
    key: string;
    box: { current: SendReceipt };
  } | null>(null);
  if (receiptBox.current?.key !== receiptStorageKey) {
    receiptBox.current = {
      key: receiptStorageKey,
      box: {
        current: readSendReceipt(localStorage, receiptStorageKey),
      },
    };
  }
  // Each in-flight continuation keeps its originating box after navigation.
  const request = receiptBox.current.box;
  const stopWorkspaceEvents = useRef<() => void>(() => {});
  const resultsVisible = useRef(true);
  // Project activity and files also follow feed changes to refresh in place.
  resultsVisible.current =
    (tab === "projects" && !!project) ||
    (!!profile && ["all", "files"].includes(view));
  const lastNavTap = useRef<{ tab: string; at: number } | null>(null);
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
  const feedBadgeRead = useFeedBadge(
    !!signedIn,
    projectFilter || teamSelection.length
      ? [executionSourceId()]
      : unified.sources.map((source) => source.id),
    projectFilter || undefined,
    teamKey || undefined,
  );
  const { draftKey, draftOwner, draftLoadedFor, pendingDraftSave } =
    useComposerDraft({
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
  const {
    items,
    setItems,
    next,
    loading: resultsLoading,
    loadResults,
    error: resultsError,
  } = useResultsLoader({
    ownerRef,
    profile,
    view,
    teamKey,
    projectFilter,
    setRevision,
  });
  const { bootstrap, loadRuns, runsGeneration, refresh } = useWorkspaceData({
    setWorkspaceLoadErrors,
    ownerRef,
    setData,
    initialAgentId,
    initialCompose: initial.compose,
    setProfile,
    setTeamSelection,
    setRuns,
    loadResults,
    setBootstrapOwner,
    openAgentChat,
  });
  useSessionLifecycle({ session, check, setError, setSession });
  useWorkspaceEvents({
    session,
    refresh,
    setError,
    profile,
    view,
    teamKey,
    projectFilter,
    setRevision,
    setCollectionRevisions,
    bootstrap,
    loadRuns,
    resultsVisible,
    loadResults,
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
  const replyQuoted = replyContext
    ? quotesReply(replyContext, conversation, latestAgentMessage)
    : false;
  const send = useComposerSend({
    composerUnavailable,
    replyQuoted,
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
  useEffect(() => {
    if (!profile) return;
    setView(
      sessionDraft<string>(
        session?.user?.id,
        executionSourceId(),
        "agent-tab",
        profile.id,
      ).read() || "all",
    );
    if (!draft.trim()) {
      setSelected(profile.id);
      setFolderChoice(undefined);
      setFolder(profile.folder_id || "");
    }
  }, [profile?.id, session?.user?.id, shellDraftSource]);
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
    editingFolder,
    editFolder,
    bootstrapOwner,
    setBootstrapOwner,
    composerOptions,
    setComposerOptions,
    composerFocusRequest,
    startChat,
    replyQuoted,
    setLatestAgentMessage,
    tab,
    lastNavTap,
    setFeedFilter,
    setFeedHomeKey,
    setTab,
    setProfile,
    setView,
    displayName,
    feedBadgeCount: feedBadgeRead.count,
    feedBadgeReadNotice: feedBadgeRead.error ? (
      <CollectionReadNotice {...feedBadgeRead} />
    ) : null,
    session,
    error,
    check,
    conversation,
    data,
    projectFilter,
    setProjectFilter,
    replyContext,
    runs,
    activeAgent,
    conversationTarget,
    folderChoice,
    contextArtifact,
    selected,
    routePreview,
    busy,
    uploading,
    draft,
    send,
    sendPress,
    composerData,
    availableAgents,
    composerRef,
    composerExpanded,
    sendNotice,
    sentRun,
    setSelected,
    setConversation,
    setSendNotice,
    attachments,
    setContextArtifact,
    setFolderChoice,
    setFolder,
    focusComposer,
    setReplyContext,
    collapseComposer,
    setDraft,
    setComposerExpanded,
    setAttachments,
    composerError,
    setComposerError,
    threadIdentity,
    setUploading,
    viewIdentity,
    threadIdentityRef,
    attachmentsRef,
    setSheet,
    setModelAgent,
    setSendMenu,
    threadWork,
    threadNotice,
    setThreadNotice,
    beginReply,
    open,
    replyToArtifact,
    archiveCard,
    setLaterCard,
    setFiling,
    ownerRef,
    changed,
    setError,
    openCard,
    resultsError,
    items,
    loadResults,
    resultsLoading,
    profile,
    view,
    teamSelection,
    profileWork,
    next,
    setTeamSelection,
    setProject,
    sheet,
    pullRefresh,
    workspaceLoadError,
    refresh,
    unified,
    stopWorkspaceEvents,
    previousPage,
    currentSourceName,
    messageTeam,
    openTeamFeed,
    project,
    teamVisibilityChanged,
    setData,
    bootstrap,
    setTeamMessages,
    scopedAgents,
    openSourcedAgent,
    feedHomeKey,
    feedFilter,
    teamKey,
    revisionFor,
    openSourcedConversation,
    focusThreadComposer,
    showScheduled,
    openLater,
    askAboutPull,
    scopedRuns,
    draftFromScheduled,
    setActiveArtifact,
    revision,
    accountName,
    myProfile,
    myProfileRead,
    artifactReadNotice: renderArtifactReadNotice(artifactReads),
    setMyProfile,
    setSettingsParent,
    searchAgent,
    searchScope,
    pull,
    setPull,
    setReviewTarget,
    dismissNotice,
    setDismissNotice,
    archivedCard,
    setArchivedCard,
    settingsParent,
    openSettingsPage,
    theme,
    setTheme,
    draftOwner,
    draftLoadedFor,
    draftRef,
    setSharedDraft,
    setRoutePreview,
    setSession,
    setItems,
    setRuns,
    setEditError,
    setSearchAgent,
    setSearchScope,
    sendMenu,
    setScheduleAt,
    scheduleAt,
    laterCard,
    openSourceLater,
    closeSheet,
    sharedDraft,
    shareAgent,
    setReturnTo,
    setShareAgent,
    setRevision,
    returnTo,
    folder,
    newAgentPrompt,
    environmentToOpen,
    environmentSetupProvider,
    creationConnections,
    creationFolders,
    setEnvironmentToOpen,
    setEnvironmentSetupProvider,
    setNewAgentPrompt,
    reviewTarget,
    teamPreset,
    setTeamPreset,
    setReturnToTeamDirectory,
    teamMessages,
    actionSource,
    threadSource,
    composerUnavailable,
    modelAgent,
    editBusy,
    setEditBusy,
    editError,
    threadData,
    conversationSource,
    messageId,
    setThreadWork,
    setConversationTarget,
    threadDraft,
    restoreToComposer,
    withdrawToComposer,
    activeArtifact,
    filing,
    filingResult,
    setFilingResult,
    setWorkspaceLoadErrors,
    setCollectionRevisions,
    loadRuns,
    resultsVisible,
  };
}

export type AppModel = ReturnType<typeof useAppController>;
