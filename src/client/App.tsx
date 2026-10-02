import { PersonalProfile } from "./PersonalProfile";
import { MyProfile, initialsOf, type MyProfileData } from "./MyProfile";
import { AgentModelSettings } from "./AgentModelSettings";
import { agentModelName, effortName, runModelName } from "./modelChoices";
import { AttachmentList, UploadButton, useAttachments } from "./Attachments";
import { MAX_MESSAGE_FILES, type UploadedFile } from "../shared/uploads";
import { capabilities } from "./capabilities";
import { NativeHistory } from "./NativeHistory";
import { NativeDecisions, WorkspaceConnection } from "./NativeControls";
import { HarnessPicker } from "./HarnessPicker";
import { RunStatus } from "./RunStatus";
import { AgentDirectory } from "./AgentDirectory";
import { YourAgents } from "./YourAgents";
import { AgentWork, currentAgentWork } from "./AgentWork";
import { agentStatusLine } from "./agentStatusLine";
import { belongsToProject } from "../shared/projects";
import { ProjectFiles } from "./ProjectFiles";
import { ProjectActivity } from "./ProjectActivity";
import { ProjectSearchResults, Projects } from "./Projects";
import { Traces } from "./Traces";
import { AgentMessages } from "./AgentMessages";
import { afterSheetsClose, closeTopSheet } from "./sheetHistory";
import { restoreScroll, usePageHistory } from "./usePageHistory";
import { cacheView, setViewOwner } from "./viewCache";
import { planSend, settleFailure, type SendReceipt } from "./sendIntent";
import { useSwipeBack } from "./useSwipeBack";
import { usePullToRefresh } from "./usePullToRefresh";
import type { ComposerContext } from "./composerContext";
import { FeedPager } from "./feed";
import {
  TeamFilter,
  CreateTeam,
  ProfileTeams,
  TeamManagerShortcut,
} from "./Teams";
import { RuntimeHosts } from "./RuntimeHosts";
import { ExecutionEnvironments } from "./ExecutionEnvironments";
import { Memory } from "./Memory";
import {
  ShareSheet,
  InstallHelp,
  initialShare,
  type SharedDraft,
} from "./Sharing";
import { PwaStatus } from "./Pwa";
import { Notifications } from "./Notifications";
import { RetireAgent } from "./RetireAgent";
import { Tools } from "./Tools";
import { WorkflowEditor } from "./Workflows";
import { Approvals } from "./Approvals";
import { Inbox, inboxFilters, type InboxFilter } from "./Inbox";
import { Later, SavedList, showLater, type SavedMessage } from "./Later";
import {
  ActionSheet,
  LaterSheet,
  ScheduledSends,
  undoReminder,
  useLongPress,
  type ScheduledSend,
} from "./ThreadTools";
import { Toasts, notify } from "./toast";
import { VoiceButton } from "./Voice";
import {
  GLOBAL_DRAFT,
  saveThreadDraft,
  setDraftOwner,
  threadDraft,
} from "./drafts";
import {
  dayLabel,
  laterChoices,
  localInputValue,
  preview,
  timeLabel,
} from "./threadView";
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  UserRound,
  Server,
  Plug,
  Download,
  Smartphone,
  Orbit,
  Newspaper,
  RefreshCw,
  AlarmClock,
  Clock3,
  Search,
  Bookmark,
  Bell,
  Plus,
  ArrowUp,
  SlidersHorizontal,
  ChevronDown,
  Folder,
  Settings,
  Monitor,
  LogOut,
  MessageSquare,
  ArrowLeft,
  MoreHorizontal,
  ArrowUpRight,
  Reply as ReplyIcon,
  Pause,
  Play,
  Square,
  Link as LinkIcon,
  CircleAlert,
  X,
} from "lucide-react";
import { api, parse } from "./api";
import { Auth } from "./Auth";
import { Connections } from "./Connections";
import { CreateAgent } from "./CreateAgent";
import {
  SearchWorkspace,
  FileSheet,
  FolderForm,
  ImportSheet,
  SearchSettings,
} from "./Workspace";
import { ArtifactViewer } from "./ArtifactViewer";
import { Conversation, type ThreadWork } from "./Conversation";
import {
  Avatar,
  Badge,
  Sheet,
  Empty,
  ArtifactCard,
  RichText,
} from "./components";
import type {
  Agent,
  Artifact,
  Connection,
  Folder as FolderType,
  Run,
  Team,
} from "../shared/types";
import "./style.css";
type Bootstrap = {
  teams?: Team[];
  agents: Agent[];
  connections: Connection[];
  folders: FolderType[];
};
const tabs = [
  { id: "inbox", label: "Feed", icon: Newspaper },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "search", label: "Search", icon: Search },
  { id: "profile", label: "You", icon: UserRound },
];
// Links and bookmarks from earlier layouts keep working. Later (Saved,
// Reminders, Scheduled) now lives on your profile.
const legacyPages: Record<string, { tab: string; filter?: InboxFilter }> = {
  feed: { tab: "inbox" },
  running: { tab: "inbox", filter: "working" },
  saved: { tab: "profile" },
  later: { tab: "profile" },
  personal: { tab: "profile" },
};
function initialPage() {
  const params = new URLSearchParams(location.search);
  const page = params.get("page") || "";
  if (tabs.some((t) => t.id === page)) return { tab: page };
  if (legacyPages[page]) return legacyPages[page];
  return { tab: params.has("folder") ? "profile" : "inbox" };
}
function initialFilter(): InboxFilter {
  const value = new URLSearchParams(location.search).get("filter");
  return inboxFilters.some((f) => f.id === value)
    ? (value as InboxFilter)
    : initialPage().filter || "done";
}
export default function App() {
  const [sharedDraft, setSharedDraft] = useState<SharedDraft>(initialShare);
  const [returnTo, setReturnTo] = useState("");
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
    [inboxFilter, setInboxFilter] = useState<InboxFilter>(initialFilter),
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
            : "",
    ),
    [error, setError] = useState(""),
    [profile, setProfile] = useState<Agent | null>(null),
    [view, setView] = useState("all"),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<number | null>(null),
    [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState(
      sessionStorage.getItem("loop-draft-agent") || "",
    ),
    [folder, setFolder] = useState(
      new URLSearchParams(location.search).get("folder") || "",
    ),
    [draft, setDraft] = useState(
      () => sessionStorage.getItem("loop-draft") || "",
    ),
    [busy, setBusy] = useState(false),
    [conversation, updateConversation] = useState<string | null>(
      new URLSearchParams(location.search).get("conversation"),
    ),
    [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null),
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
  const availableAgents = data.agents.filter((a) => !a.retired_at);
  const [messageId, setMessageId] = useState<string | null>(
    new URLSearchParams(location.search).get("message"),
  );
  const [composerExpanded, setComposerExpanded] = useState(false);
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
  const [folderChoice, setFolderChoice] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("folder") ?? undefined,
  );
  const [modelAgent, setModelAgent] = useState<Agent | null>(null);
  const [attachments, setAttachments] = useAttachments("loop-draft-files");
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
  const [archivedCard, setArchivedCard] = useState<string | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const [sendMenu, setSendMenu] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string | null>(null);
  const [newAgentPrompt, setNewAgentPrompt] = useState("");
  const [myProfile, setMyProfile] = useState<MyProfileData | null>(null);
  const [laterCard, setLaterCard] = useState<Artifact | null>(null);
  const [threadNotice, setThreadNotice] = useState("");
  // The open thread's current work, so a send can say what it will do.
  const [threadWork, setThreadWork] = useState<ThreadWork | null>(null);
  const sendPress = useLongPress(
    () => {
      if (draft.trim()) setSendMenu(true);
    },
    true,
    { onControls: true },
  );
  function setConversation(id: string | null, message?: string) {
    setConversationTarget(null);
    setMessageId(message || null);
    updateConversation(id);
    if (id) {
      const url = new URL(location.href);
      url.searchParams.set("conversation", id);
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
      url.searchParams.delete("message");
      history.replaceState(history.state, "", url.pathname + url.search);
    }
  }
  function focusComposer() {
    setComposerExpanded(true);
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>("#composer")?.focus(),
    );
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
  function collapseComposer() {
    document.querySelector<HTMLTextAreaElement>("#composer")?.blur();
    setComposerExpanded(false);
  }
  // A tapped notification opens its link in this window: a thread at its
  // message, or a result. Any other link loads normally.
  const openLink = useRef((_url: URL) => {});
  openLink.current = (url: URL) => {
    const target = url.searchParams.get("conversation");
    const artifact = url.searchParams.get("artifact");
    if (target) {
      setProfile(null);
      setConversation(target, url.searchParams.get("message") || undefined);
    } else if (artifact)
      void api<Artifact>("/artifacts/" + artifact)
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
    const added = files.filter((file) => !current.files.some((f) => f.id === file.id));
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
    const held = await api<{ input: string; attachments: UploadedFile[] }>(
      `/runs/${runId}/withdraw`,
      { draftAttachmentIds: attachmentsRef.current.map((file) => file.id) },
    );
    restoreToComposer(held.input, held.attachments);
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
  function beginReply(context: ComposerContext, text?: string) {
    setActiveArtifact(null);
    setContextArtifact(null);
    setReplyContext(context);
    setSelected(context.agentId);
    setFolderChoice(undefined);
    setComposerError("");
    const url = new URL(location.href);
    url.searchParams.delete("artifact");
    history.replaceState(history.state, "", url.pathname + url.search);
    const switching =
      !!context.conversationId && conversation !== context.conversationId;
    const previous =
      text ??
      ((context.messageId &&
        sessionStorage.getItem("loop-message-reply-" + context.messageId)) ||
        (context.artifactId &&
          sessionStorage.getItem("loop-result-reply-" + context.artifactId)) ||
        undefined);
    // Opening another thread loads that thread's own draft; seed it first.
    if (switching) {
      if (previous !== undefined && !threadDraft(context.conversationId).text)
        saveThreadDraft(context.conversationId, previous, []);
    } else if (text !== undefined) setDraft(text);
    else if (!draft.trim() && previous) setDraft(previous);
    setComposerExpanded(true);
    if (context.conversationId && conversation !== context.conversationId) {
      setConversation(context.conversationId, context.messageId);
      focusThreadComposer(context.conversationId);
    } else if (context.conversationId) focusComposer();
    else afterSheetsClose(focusComposer);
  }
  async function replyToArtifact(item: Artifact) {
    try {
      const original = await api<Artifact>("/artifacts/" + item.id);
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
      setError((error as Error).message);
    }
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
  async function archiveCard(id: string, hidden = true) {
    try {
      await api("/feed/" + id, { hidden }, "PATCH");
      setItems((old) => old.filter((item) => item.id !== id));
      setArchivedCard(hidden ? id : null);
      await loadFeed();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const [searchAgent, setSearchAgent] = useState("");
  const [projectFilter, setProjectFilter] = useState(
    new URLSearchParams(location.search).get("project") || "",
  );
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState("");
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [settingsParent, setSettingsParent] = useState(false);
  const previousPage = usePageHistory(
    JSON.stringify([
      tab,
      profile?.id,
      tab === "projects" ? project : "",
      teamKey,
    ]),
    {
      tab,
      profileId: profile?.id,
      project,
      folder,
      view,
      teamSelection,
      projectFilter,
      query,
      conversation,
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
      setFolder(previous.folder);
      setView(previous.view);
      setTeamSelection(previous.teamSelection);
      setProjectFilter(previous.projectFilter);
      setQuery(previous.query);
      setConversation(previous.conversation, previous.messageId || undefined);
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
    else if (tab !== "inbox") {
      setTab("inbox");
      setView("all");
    } else return false;
    return true;
  });
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  function closeSheet() {
    setSheet(
      sheet === "create" && ["share", "workflows", "teams"].includes(returnTo)
        ? returnTo
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
      page: tab === "inbox" ? "" : tab,
      filter: tab === "inbox" && inboxFilter !== "done" ? inboxFilter : "",
      project: projectFilter,
      teams: teamKey,
      projectView: project,
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
  }, [tab, projectFilter, teamKey, project, inboxFilter]);
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);
  const [workflowSource, setWorkflowSource] = useState<string | undefined>(
    undefined,
  );
  const [filing, setFiling] = useState<Artifact | null>(null),
    [revision, setRevision] = useState(0);
  // Your profile and its counts; refreshed while the profile is open.
  const signedIn: string | undefined = session?.user?.id;
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
  const initials = initialsOf(displayName);
  const request = useRef(
    parse<SendReceipt>(
      sessionStorage.getItem("loop-draft-receipt") || "",
      { signature: "", key: "" },
    ),
  );
  const ownerRef = useRef<string | undefined>(undefined);
  ownerRef.current = session?.user?.id;
  // Drafts are read and written only for the signed-in owner.
  setDraftOwner(session?.user?.id);
  setViewOwner(session?.user?.id);
  const personalWorkspace = useRef(false);
  const stopEventsPoll = useRef<() => void>(() => {});
  personalWorkspace.current = session?.mode === "single-user";
  const feed = useRef(new FeedPager<any>());
  const feedVisible = useRef(true);
  // Project activity and files also follow feed changes to refresh in place.
  feedVisible.current =
    (tab === "projects" && !!project) ||
    (!!profile && ["all", "files"].includes(view));
  const lastNavTap = useRef<{ tab: string; at: number } | null>(null);
  const feedContext = useRef("");
  feedContext.current = [
    session?.user?.id,
    profile?.id,
    view,
    teamKey,
    projectFilter,
  ].join(":");
  const activeAgent =
    selected === "__route__"
      ? data.agents.find((a) => a.id === routePreview?.agent?.id)
      : data.agents.find((a) => a.id === selected) ||
        (!replyContext
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
    scopedRuns
      .filter((r) => ["running", "pausing"].includes(r.state))
      .map((r) => r.agent_id),
  ).size;
  const attention = scopedRuns.filter((r) =>
    [
      "failed",
      "interrupted",
      "awaiting_approval",
      "paused",
      "waiting_children",
    ].includes(r.state),
  );
  // Each thread keeps its own unsent draft (and the global composer keeps its
  // own), so switching threads never carries text into the wrong one.
  const draftOwner = useRef<string | null>(conversation);
  // The thread whose saved draft is in the composer. Until it is, nothing is
  // saved for it: the empty composer would overwrite the saved draft.
  const draftLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    const previous = draftOwner.current;
    if (previous === conversation) return;
    draftOwner.current = conversation;
    if (previous) saveThreadDraft(previous, draft, attachments);
    else saveThreadDraft(GLOBAL_DRAFT, draft, attachments);
    const next = threadDraft(conversation || GLOBAL_DRAFT);
    setDraft(next.text);
    setAttachments(next.files);
    setComposerExpanded(false);
    setComposerError("");
    draftLoadedFor.current = conversation;
  }, [conversation]);
  // A thread opened from the address (a reload, a link) loads its saved
  // draft once the account is known, not when the thread's data arrives.
  useEffect(() => {
    if (!session?.user?.id || !conversation) return;
    if (draftLoadedFor.current === conversation) return;
    const saved = threadDraft(conversation);
    if (!draftRef.current.trim() && saved.text) setDraft(saved.text);
    if (!attachmentsRef.current.length && saved.files.length)
      setAttachments(saved.files);
    draftLoadedFor.current = conversation;
  }, [session?.user?.id, conversation]);
  useEffect(() => {
    if (!conversation || draftLoadedFor.current !== conversation) return;
    // Save for the owner who typed it, even if the session changes meanwhile.
    const owner = ownerRef.current;
    const timer = setTimeout(
      () => saveThreadDraft(conversation, draft, attachments, owner),
      400,
    );
    return () => clearTimeout(timer);
  }, [draft, attachments, conversation]);
  // Results are not polled while hidden; catch up when they come back.
  useEffect(() => {
    if (session?.user && feedVisible.current) void loadFeed(false, false);
  }, [tab, inboxFilter, project]);
  // Inside a project the default recipient is one of that project's agents.
  useEffect(() => {
    if (tab !== "projects" || !project || conversation || draft.trim()) return;
    const current = data.agents.find((a) => a.id === selected);
    if (current && belongsToProject(current.folder_id, project, data.folders))
      return;
    const agent = availableAgents.find(
      (a) => a.connection_id && belongsToProject(a.folder_id, project, data.folders),
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
  async function check() {
    const r = await fetch("/api/auth/get-session", { cache: "no-store" });
    if (
      r.redirected &&
      !r.headers.get("content-type")?.includes("application/json")
    ) {
      location.reload();
      return;
    }
    const result = await r.json();
    if (!r.ok)
      throw new Error(result.error || "Could not open your workspace.");
    setSession(
      result ? { ...result, mode: result.mode || "multi-user" } : null,
    );
  }
  const bootstrapGeneration = useRef(0);
  async function bootstrap() {
    const generation = ++bootstrapGeneration.current;
    const owner = ownerRef.current;
    const result = await api("/bootstrap");
    if (
      owner &&
      owner === ownerRef.current &&
      generation === bootstrapGeneration.current
    ) {
      setData(result);
      setTeamSelection((old) => {
        const present = old.filter((id) =>
          result.teams?.some((team: Team) => team.id === id),
        );
        return present.length === old.length ? old : present;
      });
    }
    return result.connections as Connection[];
  }
  const runsGeneration = useRef(0);
  async function loadRuns() {
    const owner = ownerRef.current;
    if (!owner) return;
    const generation = ++runsGeneration.current;
    // Profiles show all of an agent's work. Feed and Running apply their
    // team/project filters locally without changing the profile's data.
    const result = await api<Run[]>("/runs?active=1");
    if (owner === ownerRef.current && generation === runsGeneration.current)
      setRuns(result);
  }
  async function loadFeed(append = false, notify = true) {
    const owner = ownerRef.current,
      key = [owner, profile?.id, view, teamKey, projectFilter].join(
        ":",
      );
    if (!owner || key !== feedContext.current) return;
    if (feed.current.key !== key) {
      setItems([]);
      setNext(null);
      setFeedLoading(true);
    }
    setFeedError("");
    try {
      const query = () => {
        const q = new URLSearchParams({
          view:
            ["traces", "messages", "threads"].includes(view) ? "all" : view,
          teams: profile ? "" : teamKey,
        });
        if (profile) q.set("agent", profile.id);
        if (projectFilter && !profile) q.set("folder", projectFilter);
        return q;
      };
      const result = await feed.current.load(
        key,
        append,
        async (before) => {
          const q = query();
          if (before !== null) q.set("before", String(before));
          return api("/feed?" + q);
        },
        async (after, through) => {
          const q = query();
          q.set("after", String(after));
          q.set("through", String(through));
          return api("/feed/updates?" + q);
        },
      );
      if (!result || owner !== ownerRef.current || key !== feedContext.current)
        return;
      setItems(result.items);
      setNext(result.next);
      if (notify) setRevision((v) => v + 1);
    } catch (e) {
      if (key === feedContext.current) setFeedError((e as Error).message);
    } finally {
      if (key === feedContext.current) setFeedLoading(false);
    }
  }
  const refreshGeneration = useRef(0);
  async function refresh() {
    const owner = ownerRef.current;
    const generation = ++refreshGeneration.current;
    const [workspace, , tasks] = await Promise.allSettled([
      bootstrap(),
      loadFeed(),
      loadRuns(),
    ]);
    if (
      !owner ||
      owner !== ownerRef.current ||
      generation !== refreshGeneration.current
    )
      return;
    // Loading failures recover independently of action errors. A later
    // successful read must remove its warning without hiding a failed send.
    setWorkspaceLoadError(
      workspace.status === "rejected"
        ? "Couldn’t refresh your agents and projects."
        : tasks.status === "rejected"
          ? "Couldn’t refresh task status."
          : "",
    );
  }
  useEffect(() => {
    void check().catch((e) => setError(e.message));
    const expire = () => {
      if (personalWorkspace.current) {
        location.reload();
        return;
      }
      setSession(null);
      setData({ agents: [], connections: [], folders: [] });
      setItems([]);
      setRuns([]);
      setSendNotice(null);
      setWorkspaceLoadError("");
      sessionStorage.clear();
      setTeamSelection([]);
      setArchivedCard(null);
      setComposerExpanded(false);
      setDraft("");
      setSelected("");
      setFolderChoice(undefined);
      setSharedDraft({
        url: "",
        title: "",
        excerpt: "",
        question: "",
        folderId: "",
      });
      setProfile(null);
      setConversation(null);
      setActiveArtifact(null);
      setContextArtifact(null);
      setReplyContext(null);
      setRoutePreview(null);
      setFiling(null);
      setSettingsParent(false);
      setSheet("");
    };
    window.addEventListener("loop-auth-expired", expire);
    return () => window.removeEventListener("loop-auth-expired", expire);
  }, []);
  useEffect(() => {
    if (session?.user) void refresh().catch((e) => setError(e.message));
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter]);
  useEffect(() => {
    if (!session?.user) return;
    const retry = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const timer = workspaceLoadError ? setInterval(retry, 5000) : undefined;
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [
    session?.user?.id,
    profile?.id,
    view,
    teamKey,
    projectFilter,
    workspaceLoadError,
  ]);
  useEffect(() => {
    if (!session?.user) return;
    if (!capabilities.pairedDevices) {
      let cursor = 0;
      let cancelled = false;
      const active = new Set<AbortController>();
      const stop = () => {
        cancelled = true;
        clearInterval(timer);
        for (const controller of active) controller.abort();
        active.clear();
      };
      stopEventsPoll.current = stop;
      const timer = setInterval(async () => {
        if (cancelled) return;
        const controller = new AbortController();
        active.add(controller);
        try {
          const events = await api<any[]>(
            "/events?after=" + cursor,
            undefined,
            undefined,
            controller.signal,
          );
          if (cancelled) return;
          if (events.length) {
            cursor = events.at(-1).id;
            setRevision((v) => v + 1);
          }
          // One bounded changes request also catches edits made in another tab
          // and drains change batches even after streaming events stop.
          await Promise.all([
            // Result cards are only on screen in a project and agent
            // profiles; skip their poll elsewhere.
            ...(feedVisible.current
              ? [loadFeed(false, events.length === 0)]
              : []),
            ...(events.length ? [loadRuns()] : []),
          ]);
        } catch {
        } finally {
          active.delete(controller);
        }
      }, 1800);
      return () => {
        stop();
        if (stopEventsPoll.current === stop) stopEventsPoll.current = () => {};
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        setRevision((v) => v + 1);
        void refresh().catch(() => {});
      }, 200);
    };
    window.addEventListener("loop-workspace-change", update);
    const fallback = setInterval(update, 15000);
    return () => {
      clearTimeout(timer);
      clearInterval(fallback);
      window.removeEventListener("loop-workspace-change", update);
    };
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter]);
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
  useEffect(() => {
    sessionStorage.setItem("loop-draft", draft);
  }, [draft]);
  async function send(options: { queue?: boolean; sendAt?: number } = {}) {
    if (busy || uploading || !draft.trim()) return;
    if (/^@new\b/i.test(draft.trim())) {
      // "@new …" creates an agent and starts it with the rest of the message.
      setNewAgentPrompt(draft.trim().replace(/^@new\s*/i, ""));
      setFolder(projectFilter || project || "");
      setSheet("create");
      return;
    }
    if (
      !replyContext &&
      !conversation &&
      /^(put|move|file|organize)\b[\s\S]*\b(in|into|to)\b/i.test(draft)
    ) {
      if (!contextArtifact) {
        setError(
          "Open the output you want to organize first, then enter your filing instruction.",
        );
        return;
      }
      try {
        const result = await api("/artifacts/" + contextArtifact.id + "/move", {
          command: draft,
        });
        setFilingResult(result);
        setFiling(contextArtifact);
        setDraft("");
        await changed();
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    if (
      selected === "__route__" &&
      routePreview?.signature !== JSON.stringify([draft, folder])
    ) {
      setBusy(true);
      try {
        const result = await api("/routing/preview", {
          input: draft,
          folderId: folder || undefined,
        });
        setRoutePreview({
          ...result,
          signature: JSON.stringify([draft, folder]),
        });
        if (!result.agent) setSheet("create");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!activeAgent) {
      setSheet("create");
      return;
    }
    if (!draft.trim()) return;
    setBusy(true);
    setComposerError("");
    const owner = ownerRef.current;
    try {
      let recipient = activeAgent;
      if (draft.trim().startsWith("@")) {
        const route = await api("/share/preview", { question: draft });
        recipient = data.agents.find((a) => a.id === route.agent?.id)!;
        if (!recipient) throw new Error("Choose an accessible @agent.");
      }
      const managerTeam = data.teams?.find(
        (t) =>
          t.manager_id === recipient.id &&
          (profile || !teamSelection.length || teamSelection.includes(t.id)),
      );
      const reply =
        replyContext?.agentId === recipient.id ? replyContext : undefined;
      const currentConversation =
        conversation && conversationTarget?.agentId === recipient.id
          ? conversationTarget.conversationId
          : undefined;
      const conversationId =
        reply?.conversationId ||
        currentConversation ||
        (managerTeam
          ? managerTeam.conversation_id || undefined
          : contextArtifact?.agent_id === recipient.id
            ? contextArtifact.conversation_id || undefined
            : teamSelection.length === 1 &&
                data.teams?.find((t) => t.id === teamSelection[0])
                  ?.manager_id === recipient.id
              ? data.teams.find((t) => t.id === teamSelection[0])!
                  .conversation_id || undefined
              : undefined);
      const signature = JSON.stringify([
        recipient.id,
        draft,
        folderChoice,
        conversationId,
        reply?.messageId,
        attachments.map((file) => file.id),
      ]);
      // A conversation draft from the previous composer may be retrying a
      // response that was saved by the server but never acknowledged.
      const carriedKey = () => {
        const previous =
          conversationId && !reply?.messageId
            ? parse<{ signature?: string; key?: string }>(
                sessionStorage.getItem("loop-receipt-" + conversationId) || "",
                {},
              )
            : {};
        const previousSignature = JSON.stringify([
          conversationId,
          recipient.id,
          draft,
          attachments.map((file) => file.id),
        ]);
        return previous.signature === previousSignature && previous.key
          ? previous.key
          : crypto.randomUUID();
      };
      // The send's mode and exact time travel with its key: a retry after a
      // lost response repeats the same request rather than a changed one.
      const plan = planSend(
        request.current,
        signature,
        {
          mode: options.sendAt ? "schedule" : options.queue ? "queue" : "send",
          sendAt: options.sendAt ?? null,
        },
        carriedKey,
      );
      request.current = plan.receipt;
      sessionStorage.setItem(
        "loop-draft-receipt",
        JSON.stringify(request.current),
      );
      const reconciled = plan.reconciled
        ? plan.intent.mode === "schedule"
          ? ` Your earlier request went through as first sent: scheduled for ${dayLabel(plan.intent.sendAt!).toLowerCase()} at ${timeLabel(plan.intent.sendAt!)}. Change it in Later → Scheduled.`
          : " Your earlier request went through as first sent."
        : "";
      options =
        plan.intent.mode === "schedule"
          ? { sendAt: plan.intent.sendAt! }
          : plan.intent.mode === "queue"
            ? { queue: true }
            : {};
      const body = {
        agentId: recipient.id,
        conversationId,
        replyToMessageId: reply?.messageId,
        input: draft,
        idempotencyKey: request.current.key,
        attachmentIds: attachments.map((file) => file.id),
        folderId:
          folderChoice !== undefined
            ? folderChoice || null
            : conversationId
              ? undefined
              : recipient.folder_id || undefined,
      };
      if (options.sendAt) {
        const row = await api<{ id: string }>("/scheduled-sends", {
          ...body,
          sendAt: options.sendAt,
        });
        if (owner !== ownerRef.current) return;
        const when = `${dayLabel(options.sendAt).toLowerCase()} at ${timeLabel(options.sendAt)}`;
        const text = draft;
        // Undo cancels it while it is still waiting; once it has been sent,
        // the server refuses and says so.
        notify({
          text: `Scheduled for @${recipient.name}, ${when}.${reconciled}`,
          link: { label: "View", onSelect: () => showScheduled(row.id) },
          undo: async () => {
            await api("/scheduled-sends/" + row.id, undefined, "DELETE");
            window.dispatchEvent(new Event("loop-scheduled-change"));
            setDraft((current) => (current.trim() ? current : text));
          },
        });
        window.dispatchEvent(new Event("loop-scheduled-change"));
        setDraft("");
        setAttachments([]);
        request.current = { signature: "", key: "" };
        sessionStorage.removeItem("loop-draft-receipt");
        setReplyContext(conversation && conversationTarget ? conversationTarget : null);
        if (!conversation) collapseComposer();
        return;
      }
      const accepted = await api<Run & { steeringId?: string }>("/runs", {
        ...body,
        ...(options.queue ? { queue: true } : {}),
      });
      if (owner !== ownerRef.current) return;
      // Publish the confirmed receipt before any background refresh. Discard
      // older reads so a response started before this send cannot erase it.
      ++runsGeneration.current;
      if (accepted.agent_id && accepted.state)
        setRuns((old) => [
          { ...old.find((run) => run.id === accepted.id), ...accepted },
          ...old.filter((run) => run.id !== accepted.id),
        ]);
      if (!conversation)
        setSendNotice({
        runId: accepted.id,
        conversationId: accepted.conversation_id || conversationId || null,
        agentId: recipient.id,
        agentName: recipient.name,
        steering: Boolean(accepted.steeringId),
      });
      setDraft("");
      setAttachments([]);
      request.current = { signature: "", key: "" };
      sessionStorage.removeItem("loop-draft-receipt");
      if (conversationId) {
        saveThreadDraft(conversationId, "", []);
        sessionStorage.removeItem("loop-receipt-" + conversationId);
      }
      if (reply?.messageId)
        sessionStorage.removeItem("loop-message-reply-" + reply.messageId);
      if (reply?.artifactId)
        sessionStorage.removeItem("loop-result-reply-" + reply.artifactId);
      // Stay in the thread after sending; its reply context returns to the
      // conversation itself rather than the quoted message.
      setReplyContext(conversation && conversationTarget ? conversationTarget : null);
      setContextArtifact(null);
      if (options.queue && conversation)
        notify({
          text: "Queued after the current task." + reconciled,
          // Undo takes it back to a draft, only while it has not started.
          undo: async () => {
            await withdrawToComposer(accepted.id);
            void refresh();
          },
        });
      else if (reconciled && conversation) setThreadNotice(reconciled.trim());
      else if (reconciled) setDismissNotice(reconciled.trim());
      if (!conversation) collapseComposer();
      else document.querySelector<HTMLTextAreaElement>("#composer")?.blur();
      void refresh().catch((e) => setError(e.message));
    } catch (e) {
      // A refusal means nothing was accepted, so a different choice may be
      // sent next; anything else stays pending and is retried as first sent.
      if (request.current.signature) {
        request.current = settleFailure(
          request.current,
          (e as { status?: number }).status,
        );
        sessionStorage.setItem(
          "loop-draft-receipt",
          JSON.stringify(request.current),
        );
      }
      if (owner === ownerRef.current) setComposerError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
  async function open(item: Artifact) {
    setFolderChoice(undefined);
    try {
      item = await api<Artifact>("/artifacts/" + item.id);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
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
      void api<Artifact>("/artifacts/" + artifact)
        .then(setActiveArtifact)
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
    if (conversation || profile || draft.trim() || replyContext) return;
    const target =
      scopedAgents.find((a) => a.id === selected) ||
      scopedAgents.find((a) => a.connection_id);
    if (target) {
      setSelected(target.id);
      setFolderChoice(undefined);
      setFolder(target.folder_id || "");
    }
  }, [projectFilter, teamKey, data.agents, conversation]);
  const nav = (
    <>
      {tabs.map((t) => (
        <button
          key={t.id}
          aria-label={t.label}
          aria-current={tab === t.id ? "page" : undefined}
          className={tab === t.id ? "current" : ""}
          onClick={() => {
            if (t.id === tab) {
              const now = performance.now();
              if (
                lastNavTap.current?.tab === t.id &&
                now - lastNavTap.current.at < 350
              ) {
                lastNavTap.current = null;
                requestAnimationFrame(() =>
                  window.scrollTo({
                    top: 0,
                    behavior: window.matchMedia(
                      "(prefers-reduced-motion: reduce)",
                    ).matches
                      ? "instant"
                      : "smooth",
                  }),
                );
              } else lastNavTap.current = { tab: t.id, at: now };
            } else {
              lastNavTap.current = null;
            }
            setTab(t.id);
            setProfile(null);
            setView("all");
          }}
        >
          {t.id === "profile" ? (
            <span className="avatar user nav-avatar" aria-hidden="true">
              {initials}
            </span>
          ) : (
            <t.icon size={21} />
          )}
          <span>{t.label}</span>
          {t.id === "inbox" && runningAgentCount > 0 && (
            <small
              className="running-count"
              aria-label={`${runningAgentCount} ${runningAgentCount === 1 ? "agent" : "agents"} running`}
            >
              {runningAgentCount > 9 ? "9+" : runningAgentCount}
            </small>
          )}
        </button>
      ))}
    </>
  );
  if (session === undefined)
    return (
      <div className="loading">
        <Orbit className="spin" />
        <p>{error || "Opening your workspace…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </div>
    );
  if (!session?.user) return <Auth onDone={() => void check()} />;
  const threadMode = Boolean(conversation);
  // The project filter shared by the Feed and your Saved list.
  const projectScope = data.folders.some((f) => f.kind === "project") && (
    <label className="scope-chip">
      <span className="sr-only">Project</span>
      <select
        aria-label="Filter by project"
        value={projectFilter}
        onChange={(e) => setProjectFilter(e.target.value)}
      >
        <option value="">All projects</option>
        {data.folders
          .filter((f) => f.kind === "project")
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
      </select>
    </label>
  );
  const quoted =
    replyContext?.content &&
    (replyContext.messageId || replyContext.artifactId || !conversation)
      ? replyContext
      : null;
  // Who and where a send goes, said before it is sent.
  const topProject = (folderId?: string | null) => {
    let folder = data.folders.find((f) => f.id === folderId);
    while (folder?.parent_id)
      folder = data.folders.find((f) => f.id === folder!.parent_id);
    return folder?.name;
  };
  // Outside a thread, sending now to an agent with a running task steers
  // that task (the server joins its active conversation).
  const steersActive =
    !threadMode &&
    !replyContext?.conversationId &&
    runs.some(
      (run) =>
        run.agent_id === activeAgent?.id &&
        ["running", "awaiting_approval"].includes(run.state),
    );
  const destination = {
    agent: activeAgent?.name || "agent",
    project:
      (threadMode
        ? conversationTarget?.projectName
        : topProject(
            folderChoice !== undefined
              ? folderChoice
              : contextArtifact?.agent_id === activeAgent?.id
                ? contextArtifact?.folder_id
                : activeAgent?.folder_id,
          )) || "Unfiled",
    thread: threadMode
      ? conversationTarget?.title || "This thread"
      : replyContext?.conversationId
        ? replyContext.title || "Its thread"
        : "New thread",
  };
  const sendButton = (
    <button
      className={"send-button" + (threadMode ? " round" : "")}
      aria-label={
        selected === "__route__" && !routePreview
          ? "Preview route"
          : replyContext || conversation
            ? "Send reply"
            : "Send message"
      }
      title="Hold for more send options"
      disabled={
        busy || uploading || !draft.trim() || !!activeAgent?.retired_at
      }
      onClick={() => void send()}
      {...sendPress}
    >
      {!threadMode &&
        (busy
          ? "Sending…"
          : selected === "__route__" && !routePreview
            ? "Preview"
            : "Send")}
      <ArrowUp size={19} />
    </button>
  );
  const messageComposer =
    availableAgents.length > 0 ? (
      <section
        ref={composerRef}
        className={
          "composer-dock " +
          (composerExpanded ? "expanded" : "collapsed") +
          (threadMode ? " thread-mode" : "")
        }
      >
        {sendNotice && !composerExpanded && !conversation && (
          <div className="send-confirmation" role="status">
            <span>
              {sendNotice.steering
                ? "Follow-up accepted for"
                : sentRun?.state === "queued"
                  ? "Queued for"
                  : ["running", "pausing", "waiting_children"].includes(
                        sentRun?.state || "",
                      )
                    ? "Running with"
                    : "Message sent to"}{" "}
              <strong>@{sendNotice.agentName}</strong>
            </span>
            {sendNotice.conversationId && (
              <button
                className="text-button"
                onClick={() => {
                  setSelected(sendNotice.agentId);
                  setConversation(sendNotice.conversationId);
                  setSendNotice(null);
                }}
              >
                View conversation <ArrowUpRight size={16} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Dismiss send confirmation"
              onClick={() => setSendNotice(null)}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {!composerExpanded && !threadMode && (
          <button
            className={"composer-launch" + (draft ? " has-draft" : "")}
            onClick={focusComposer}
            aria-label="Compose a message"
            aria-expanded={false}
            title={
              (draft
                ? `Continue draft to @${activeAgent?.name || "agent"}`
                : activeAgent
                  ? `New task for @${activeAgent.name}`
                  : "New task") +
              (activeAgent ? ` · ${destination.project}` : "")
            }
          >
            <Plus size={26} aria-hidden="true" />
          </button>
        )}
        <div className="composer" hidden={!composerExpanded && !threadMode}>
          {!threadMode && (
            <div className="composer-heading">
              <label className="composer-field">
                <span className="sr-only">Send to</span>
                <select
                  aria-label="Agent recipient"
                  disabled={busy || uploading}
                  value={
                    selected === "__route__" ? "__route__" : activeAgent?.id || ""
                  }
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setReplyContext(null);
                    setContextArtifact(null);
                    setFolderChoice(undefined);
                    const agent = data.agents.find(
                      (a) => a.id === e.target.value,
                    );
                    if (agent) setFolder(agent.folder_id || "");
                  }}
                >
                  {!availableAgents.length && (
                    <option value="">Choose your first agent</option>
                  )}
                  <option value="__route__">Let Loop route this</option>
                  {activeAgent?.retired_at && (
                    <option value={activeAgent.id} disabled>
                      @{activeAgent.name} · Retired
                    </option>
                  )}
                  {availableAgents.map((a) => (
                    <option value={a.id} key={a.id}>
                      @{a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="composer-collapse text-button"
                onClick={collapseComposer}
                aria-label="Collapse composer"
              >
                <ChevronDown size={18} /> Minimize
              </button>
            </div>
          )}
          {!threadMode && activeAgent && selected !== "__route__" && (
            <p className="composer-destination">
              To <strong>@{destination.agent}</strong> · Project{" "}
              <strong>{destination.project}</strong> ·{" "}
              {steersActive
                ? "Sending now steers its current task"
                : destination.thread}
            </p>
          )}
          {activeAgent?.retired_at && (
            <p className="note">
              This agent is retired. Restore it from its profile to send new
              work.
            </p>
          )}
          {selected === "__route__" && routePreview && (
            <p className="route-preview">
              {routePreview.agent
                ? "Recipient: @" + routePreview.agent.name + " · "
                : ""}
              {routePreview.reason}
            </p>
          )}
          {quoted && (
            <div className="composer-reply-chip">
              <ReplyIcon size={16} aria-hidden="true" />
              <details className="composer-quote-toggle">
                <summary>
                  Replying to{" "}
                  {quoted.mine
                    ? "your message"
                    : "@" + (activeAgent?.name || "agent")}
                  :{" "}
                  <span>{preview(quoted.content!, 80)}</span>
                </summary>
                <div
                  className="composer-quote"
                  role="region"
                  aria-label="Original message"
                  tabIndex={0}
                >
                  <RichText content={quoted.content!} compact />
                </div>
              </details>
              <button
                className="icon-button"
                aria-label="Clear reply context"
                onClick={() =>
                  setReplyContext(
                    conversation && conversationTarget ? conversationTarget : null,
                  )
                }
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!replyContext && contextArtifact && (
            <div className="context-strip">
              <span>About: {contextArtifact.title}</span>
              <button
                aria-label="Clear conversation context"
                onClick={() => setContextArtifact(null)}
              >
                ×
              </button>
            </div>
          )}
          <div className="composer-main">
            <textarea
              id="composer"
              aria-label={
                replyContext || conversation
                  ? "Reply to agent"
                  : "Message your agent"
              }
              disabled={busy}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => {
                if (threadMode) setComposerExpanded(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setComposerExpanded(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                threadMode
                  ? `Reply to @${activeAgent?.name || "agent"}…`
                  : "An idea, a question, a ‘what if’… (@new creates an agent)"
              }
              rows={threadMode ? 1 : 2}
            />
            {threadMode && sendButton}
          </div>
          <AttachmentList
            files={attachments}
            onRemove={(id) =>
              setAttachments(attachments.filter((file) => file.id !== id))
            }
          />
          {composerError && (
            <div className="composer-error error" role="alert">
              {composerError}
              <button
                type="button"
                className="text-button"
                onClick={() => setComposerError("")}
              >
                Dismiss
              </button>
            </div>
          )}
          <div className="composer-actions">
            <UploadButton
              menu
              folderId={folderChoice ?? activeAgent?.folder_id}
              agentId={activeAgent?.id}
              disabled={busy}
              remaining={MAX_MESSAGE_FILES - attachments.length}
              onBusy={setUploading}
              onUploaded={(file) => {
                attachmentsRef.current = [...attachmentsRef.current, file];
                setAttachments(attachmentsRef.current);
              }}
            />
            <HarnessPicker
              compact
              conversationId={
                replyContext?.conversationId || (conversation ?? undefined)
              }
              agentId={selected === "__route__" ? undefined : activeAgent?.id}
              value={draft}
              onChange={setDraft}
              focusInput={() => document.getElementById("composer")?.focus()}
            />
            <VoiceButton value={draft} onChange={setDraft} disabled={busy} />
            <button
              type="button"
              className="composer-model"
              aria-label="Select model and effort"
              aria-haspopup="dialog"
              disabled={!activeAgent}
              onClick={() => activeAgent && setModelAgent(activeAgent)}
            >
              {activeAgent ? (
                <>
                  <span className="composer-model-label">
                    <span className="composer-model-name">
                      {agentModelName(activeAgent, data.connections)}
                    </span>
                    {!threadMode && (
                      <small className="composer-effort">
                        {effortName(activeAgent.effort)} effort
                      </small>
                    )}
                  </span>
                  <ChevronDown size={15} />
                </>
              ) : (
                "Select an agent"
              )}
            </button>
            <button
              type="button"
              className="icon-button composer-later"
              aria-label="Send later"
              title="Send later or after the current task"
              disabled={!draft.trim() || busy}
              onClick={() => setSendMenu(true)}
            >
              <Clock3 size={18} />
            </button>
            {!threadMode && sendButton}
          </div>
          {threadMode && threadWork && draft.trim() && (
            <p className="field-hint composer-intent">
              {threadWork.steerable
                ? `Send steers @${destination.agent}’s current task.`
                : `Send waits for @${destination.agent}’s current task.`}{" "}
              Tap the clock to {threadWork.steerable ? "queue it or " : ""}send
              later.
            </p>
          )}
          {threadNotice && threadMode && (
            <p className="field-hint composer-notice" role="status">
              {threadNotice}
              <button
                type="button"
                className="text-button"
                onClick={() => setThreadNotice("")}
              >
                OK
              </button>
            </p>
          )}
        </div>
      </section>
    ) : null;
  async function unsaveResult(item: Artifact) {
    const current = await api<Artifact>("/artifacts/" + item.id);
    await api(
      "/artifacts/" + item.id,
      { pinned: false, version: current.version },
      "PATCH",
    );
    void changed();
  }
  const replySaved = (message: SavedMessage) =>
    message.agent_id
      ? beginReply({
          agentId: message.agent_id,
          conversationId: message.conversation_id,
          messageId: message.message_id,
          content: message.content,
          ...(message.role === "user" ? { mine: true } : {}),
        })
      : setConversation(message.conversation_id, message.message_id);
  // Result cards look and act the same in the feed, projects and Saved.
  const resultCard = (
    item: Artifact & { team_id?: string | null },
    inSaved = false,
    onUnsave?: () => void,
  ) => (
    <ArtifactCard
      key={item.id}
      item={item}
      connections={data.connections}
      project={[
        data.teams?.find((t) => t.id === item.team_id)?.name,
        data.folders.find((f) => f.id === item.folder_id)?.name ||
          "Unfiled",
      ]
        .filter(Boolean)
        .join(" · ")}
      onOpen={() => openCard(item)}
      onArtifact={() => void open(item)}
      onReply={() => void replyToArtifact(item)}
      onArchive={inSaved ? undefined : () => void archiveCard(item.id)}
      onLater={() => setLaterCard(item)}
      onProfile={() =>
        setProfile(
          data.agents.find((a) => a.id === item.agent_id) || null,
        )
      }
      onFile={() => setFiling(item)}
      onPin={async () => {
        // In Saved, unsaving waits for its Undo (see SavedList).
        if (onUnsave && item.pinned) return onUnsave();
        try {
          await api(
            "/artifacts/" + item.id,
            { pinned: !item.pinned, version: item.version },
            "PATCH",
          );
          await changed();
          window.dispatchEvent(new Event("loop-later-change"));
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    />
  );
  const feedList = (
    <div className="feed">
      {feedError && items.length > 0 && (
        <div className="error" role="alert">
          {feedError}
          <button className="text-button" onClick={() => void loadFeed()}>
            Try again
          </button>
        </div>
      )}
      {feedLoading ? (
        <div className="feed-loading" role="status" aria-label="Loading activity">
          <span />
          <span />
          <span />
        </div>
      ) : feedError && !items.length ? (
        <div className="error" role="alert">
          {feedError}
          <button className="text-button" onClick={() => void loadFeed()}>
            Try again
          </button>
        </div>
      ) : items.length ? (
        items
          // Snippets are reusable prompts, not agent output; they live in the
          // composer's / menu instead of the results list.
          .filter(
            (item) =>
              !item.role && !parse<any>(item.metadata, {}).snippet,
          )
          .map((item) => resultCard(item))
      ) : (
        <Empty
          title={
            profile
              ? view === "files"
                ? "No files yet."
                : "No results yet."
              : projectFilter || teamSelection.length
                ? "No results in this view yet."
                : "No results yet."
          }
        >
          {profile
            ? profileWork.length
              ? "Your agent’s work is shown above. Open its thread to follow along."
              : "Send a message to this agent to get started."
            : "Finished work from your agents appears here."}
        </Empty>
      )}
      {next && (
        <button
          className="secondary load-more"
          onClick={() => void loadFeed(true)}
        >
          Earlier results
        </button>
      )}
    </div>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="wordmark"
          onClick={() => {
            setTab("inbox");
            setProfile(null);
            setTeamSelection([]);
          }}
        >
          <Orbit />
          loop
          <span className="wordmark-dot" />
        </button>
        <nav>{nav}</nav>
        <div className="sidebar-label">
          WORKSPACE
          <button
            className="icon-button"
            aria-label="New project"
            onClick={() => {
              setFolder("");
              setTab("projects");
              setSheet("project");
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {data.folders
          .filter((f) => !f.parent_id)
          .map((f) => (
            <button
              key={f.id}
              className="project-nav"
              onClick={() => {
                setFolder(f.id);
                setProject(f.id);
                setProfile(null);
                setTab("projects");
              }}
            >
              <Folder size={17} />
              {f.name}
            </button>
          ))}
        {!data.folders.length && (
          <p className="field-hint">Projects give your work a home.</p>
        )}
      </aside>
      <div className="main-column">
        <PwaStatus />
        <header className="topbar">
          <div className="wordmark mobile-brand">
            <Orbit />
            loop
            <span className="wordmark-dot" />
          </div>
          <span className="desktop-breadcrumb">
            Workspace <span>/</span>{" "}
            {profile
              ? "@" + profile.name
              : tabs.find((t) => t.id === tab)?.label}
          </span>
          <div className="topbar-actions">
            <span className="private-indicator">
              <span />
              Private workspace
            </span>
            <button
              className="settings-button"
              aria-label="Open settings"
              aria-expanded={sheet === "settings"}
              onClick={() => setSheet("settings")}
            >
              <Settings size={20} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="workspace-content">
          {(pullRefresh.pull > 0 || pullRefresh.refreshing) && (
            <div
              className={
                "pull-refresh" +
                (pullRefresh.ready ? " ready" : "") +
                (pullRefresh.refreshing ? " refreshing" : "")
              }
              style={
                pullRefresh.refreshing
                  ? undefined
                  : { transform: `translateY(${pullRefresh.pull}px)` }
              }
              role="status"
              aria-label={
                pullRefresh.refreshing
                  ? "Refreshing"
                  : pullRefresh.ready
                    ? "Release to refresh"
                    : "Pull to refresh"
              }
            >
              <RefreshCw size={18} aria-hidden="true" />
            </div>
          )}
          {workspaceLoadError && (
            <div className="workspace-load-status note" role="status">
              <span>{workspaceLoadError} Retrying…</span>
              <button className="text-button" onClick={() => void refresh()}>
                Retry now
              </button>
            </div>
          )}
          {capabilities.pairedDevices && <WorkspaceConnection />}
          {profile ? (
            <>
              <button
                className="text-button back-button"
                onClick={() => {
                  if (previousPage()) return;
                  setProfile(null);
                  setView("all");
                }}
              >
                <ArrowLeft size={16} />
                Back
              </button>
              <section className="profile-head">
                <button
                  className="icon-button profile-menu"
                  aria-label="Agent actions"
                  onClick={() => setSheet("agent-menu")}
                >
                  <MoreHorizontal size={20} />
                </button>
                <Avatar name={profile.name} provider={profile.provider} />
                <h1>@{profile.name}</h1>
                <Badge provider={profile.provider} />
                <p className="muted profile-model">
                  {agentModelName(profile, data.connections)}
                </p>
                <p className="profile-status">
                  {profile.instructions ||
                    (profileWork.some((run) =>
                      ["running", "pausing", "waiting_children"].includes(
                        run.state,
                      ),
                    )
                      ? agentStatusLine(
                          profile.id,
                          profileWork.find((run) =>
                            ["running", "pausing", "waiting_children"].includes(
                              run.state,
                            ),
                          )?.id,
                        )
                      : profileWork.some((run) =>
                            ["paused", "awaiting_approval"].includes(run.state),
                          )
                        ? "Waiting for your input."
                        : profileWork.length
                          ? "Your work is queued."
                          : agentStatusLine(profile.id))}
                </p>
                <ProfileTeams
                  agent={profile}
                  teams={data.teams || []}
                  onMessage={messageTeam}
                  onOpen={(team) => {
                    setProfile(null);
                    setTab("inbox");
                    setView("all");
                    setTeamSelection([team.id]);
                    setProjectFilter("");
                    if (!draft.trim() && !attachments.length) {
                      setSelected(team.manager_id);
                      setReplyContext(null);
                      setContextArtifact(null);
                    }
                    afterSheetsClose(() =>
                      window.scrollTo({ top: 0, behavior: "instant" }),
                    );
                  }}
                />
                {profile.retired_at && (
                  <p className="note" role="status">
                    Retired · History stays available. Restore this agent to
                    send new work.
                  </p>
                )}
                <div className="profile-actions">
                  <button
                    className="primary"
                    disabled={!!profile.retired_at}
                    onClick={() => {
                      setSelected(profile.id);
                      setFolderChoice(undefined);
                      setFolder(profile.folder_id || "");
                      setReplyContext(null);
                      focusComposer();
                    }}
                  >
                    <MessageSquare size={16} />
                    Message
                  </button>
                </div>
                <AgentWork
                  runs={profileWork}
                  onConversation={setConversation}
                />
              </section>

              <div className="segmented scroll-tabs" role="tablist">
                {[
                  ["all", "Results"],
                  ["threads", "Threads"],
                  ["messages", "Messages"],
                  ["files", "Files"],
                  ["traces", "Traces"],
                ].map(([v, label]) => (
                  <button
                    className={view === v ? "selected" : ""}
                    key={v}
                    role="tab"
                    aria-selected={view === v}
                    aria-pressed={view === v}
                    onClick={() => {
                      setView(v);
                      if (profile)
                        sessionStorage.setItem(
                          "loop-agent-tab-" + profile.id,
                          v,
                        );
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (tab === "projects" && project) || tab === "profile" ? null : (
            <div className="page-heading compact">
              <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
              {tab === "inbox" && projectScope}
            </div>
          )}
          {tab === "inbox" && !profile && !!data.teams?.length && (
            <div className="workspace-scope">
              <TeamFilter
                teams={data.teams || []}
                selected={teamSelection}
                onDeleted={(id) => {
                  setData((old) => ({
                    ...old,
                    teams: old.teams?.filter((team) => team.id !== id),
                  }));
                  setTeamSelection((old) => old.filter((team) => team !== id));
                  void bootstrap();
                }}
                onChange={(ids) => {
                  setTeamSelection(ids);
                  const team =
                    ids.length === 1
                      ? data.teams?.find((t) => t.id === ids[0])
                      : undefined;
                  if (team && !draft.trim()) {
                    setSelected(team.manager_id);
                    setContextArtifact(null);
                  }
                }}
                onCreate={() => setSheet("teams")}
                onOpen={messageTeam}
              />
              <TeamManagerShortcut
                teams={data.teams || []}
                agents={data.agents}
                selected={teamSelection}
                onOpen={messageTeam}
              />
            </div>
          )}
          {tab === "inbox" && !profile && (
            <>
              {data.agents.length > 0 && (
                <YourAgents
                  agents={scopedAgents}
                  connections={data.connections}
                  runs={runs}
                  onProfile={setProfile}
                  onCreate={() => {
                    setFolder(projectFilter);
                    setSheet("create");
                  }}
                />
              )}
              <Inbox
                filter={inboxFilter}
                onFilter={setInboxFilter}
                project={projectFilter || undefined}
                teams={teamKey || undefined}
                revision={revision}
                agents={data.agents}
                onOpen={(c, m) => setConversation(c, m)}
                onReply={(c) => {
                  setConversation(c);
                  focusThreadComposer(c);
                }}
                connections={data.connections}
                onAgent={setProfile}
                onChanged={() => void changed()}
                onScheduled={() => showScheduled()}
                onShowReminder={(id) => openLater("reminders", id)}
                needsSlot={
                  <div className="run-list">
                    {capabilities.nativeHarnesses && (
                      <NativeDecisions onConversation={setConversation} />
                    )}
                    <Approvals
                      teams={teamKey}
                      runIds={
                        projectFilter ? scopedRuns.map((r) => r.id) : undefined
                      }
                      revision={revision}
                      onChange={() => void changed()}
                      onConversation={setConversation}
                    />
                    <ScheduledSends
                      revision={revision}
                      failedOnly
                      onOpen={(c) => setConversation(c)}
                      onDraft={draftFromScheduled}
                    />
                  </div>
                }
                emptyAction={
                  <button
                    className="primary"
                    onClick={() =>
                      data.agents.length ? focusComposer() : setSheet("create")
                    }
                  >
                    <Plus size={17} />
                    {data.agents.length
                      ? "Start a conversation"
                      : "Create your first agent"}
                  </button>
                }
              />
            </>
          )}
          {profile && view === "traces" && (
            <Traces
              key={profile.id}
              agentId={profile.id}
              revision={revision}
              onConversation={setConversation}
              onArtifact={setActiveArtifact}
            />
          )}
          {profile && view === "threads" && (
              <Inbox
              key={"agent-" + profile.id}
              filter="all"
              onFilter={() => {}}
              hideFilters
              agent={profile.id}
              revision={revision}
              agents={data.agents}
              connections={data.connections}
              onOpen={(c, m) => {
                setSelected(profile.id);
                setConversation(c, m);
              }}
              onReply={(c) => {
                setSelected(profile.id);
                setConversation(c);
                focusThreadComposer(c);
              }}
              onAgent={setProfile}
              onChanged={() => void changed()}
            />
          )}
          {profile && view === "messages" && (
            <AgentMessages
              key={profile.id}
              agent={profile}
              revision={revision}
              onConversation={setConversation}
              onReply={beginReply}
            />
          )}
          {profile && ["all", "files"].includes(view) && feedList}
          {tab === "profile" && !profile && (
            <MyProfile
              name={displayName}
              accountName={accountName}
              profile={myProfile}
              onSaved={setMyProfile}
              messages={
                <PersonalProfile
                  embedded
                  name={displayName}
                  agents={data.agents}
                  onAgent={setProfile}
                  onConversation={(c, m) => setConversation(c, m)}
                  onReply={(prompt) =>
                    beginReply({
                      agentId: prompt.agent_id,
                      conversationId: prompt.conversation_id,
                      messageId: prompt.id,
                      content: prompt.content,
                      mine: true,
                    })
                  }
                />
              }
              later={(section) => (
                <>
                  {section === "saved" && projectScope && (
                    <div className="later-scope">{projectScope}</div>
                  )}
                <Later
                  key={section}
                  only={section}
                  project={
                    section === "saved" ? projectFilter || undefined : undefined
                  }
                  revision={revision}
                  onOpen={(c, m) => setConversation(c, m)}
                  onArtifact={(id) =>
                    void api<Artifact>("/artifacts/" + id)
                      .then((item) => void open(item))
                      .catch((e) => setError(e.message))
                  }
                  teams={teamKey || undefined}
                  renderResult={(item, options) =>
                    resultCard(item, true, options.onUnsave)
                  }
                  onUnsaveResult={unsaveResult}
                  onDraft={draftFromScheduled}
                  onReply={replySaved}
                />
                </>
              )}
            />
          )}
          {tab === "search" && !profile && (
            <SearchWorkspace
              key={searchAgent + ":" + searchScope}
              userName={session.user.name?.trim() || "You"}
              initialScope={searchScope}
              onProfile={setProfile}
              initialAgent={searchAgent}
              agents={data.agents}
              folders={data.folders}
              onOpen={open}
              onConversation={(c, m) => {
                setConversation(c, m);
              }}
              onReplyPrompt={(prompt) =>
                beginReply({
                  agentId: prompt.agent_id,
                  conversationId: prompt.conversation_id,
                  messageId: prompt.id,
                  content: prompt.content,
                  mine: true,
                })
              }
            />
          )}
          {tab === "projects" && !profile && (
            <Projects
              folders={data.folders}
              agents={data.agents}
              selected={project}
              onSelect={setProject}
              onCreate={() => {
                setFolder("");
                setSheet("project");
              }}
              onCreateAgent={(id) => {
                setFolder(id);
                setSheet("create");
              }}
              onAgent={setProfile}
              onAssign={async (a, id) => {
                await api(`/agents/${a.id}`, { folderId: id }, "PATCH");
                await bootstrap();
              }}
              renderActivity={(id) => (
                <ProjectActivity
                  key={id}
                  projectId={id}
                  agents={data.agents}
                  connections={data.connections}
                  revision={revision}
                  onOpen={open}
                  onReply={(item) => void replyToArtifact(item)}
                  onConversation={setConversation}
                  onAgent={setProfile}
                  onFile={setFiling}
                />
              )}
              renderFiles={(id) => (
                <>
                  <UploadButton
                    folderId={id}
                    label="Upload files"
                    onUploaded={() => {
                      void changed();
                    }}
                  />
                  <ProjectFiles
                    key={id}
                    embedded
                    folders={data.folders}
                    folder={id}
                    onFolder={setProject}
                    onOpen={open}
                    onFile={setFiling}
                    onCreate={() => {
                      setFolder(id);
                      setSheet("project");
                    }}
                    onEdit={() => {
                      setFolder(id);
                      setSheet("folder-edit");
                    }}
                    version={revision}
                  />
                </>
              )}
              onEdit={() => {
                setFolder(project);
                setSheet("folder-edit");
              }}
              revision={revision}
              renderThreads={(id) => (
                <Inbox
                  key={id}
                  filter="all"
                  onFilter={() => {}}
                  hideFilters
                  project={id}
                  revision={revision}
                  agents={data.agents}
                  onOpen={(c, m) => setConversation(c, m)}
                  onReply={(c) => {
                    setConversation(c);
                    focusThreadComposer(c);
                  }}
                  connections={data.connections}
                  onAgent={setProfile}
                  onChanged={() => void changed()}
                />
              )}
              renderHistory={(id, view, text) =>
                view === "search" ? (
                  <ProjectSearchResults
                    project={id}
                    query={text}
                    onConversation={(c, m) => setConversation(c, m)}
                    onArtifact={(artifact) =>
                      void api<Artifact>("/artifacts/" + artifact)
                        .then((item) => void open(item))
                        .catch((e) => setError(e.message))
                    }
                  />
                ) : view === "saved" ? (
                  <SavedList
                    key={id}
                    revision={revision}
                    project={id}
                    searchLabel="Search saved decisions"
                    onOpen={(c, m) => setConversation(c, m)}
                    onReply={replySaved}
                    renderResult={(item, options) =>
                      resultCard(item, true, options.onUnsave)
                    }
                    onUnsaveResult={unsaveResult}
                  />
                ) : (
                  <Inbox
                    key={id + view}
                    filter={view}
                    onFilter={() => {}}
                    hideFilters
                    project={id}
                    revision={revision}
                    agents={data.agents}
                    onOpen={(c, m) => setConversation(c, m)}
                    onReply={(c) => {
                      setConversation(c);
                      focusThreadComposer(c);
                    }}
                    connections={data.connections}
                    onAgent={setProfile}
                    onChanged={() => void changed()}
                  />
                )
              }
              onNewTask={(id) => {
                const agent =
                  data.agents.find(
                    (a) =>
                      !a.retired_at &&
                      a.connection_id &&
                      a.id === selected &&
                      belongsToProject(a.folder_id, id, data.folders),
                  ) ||
                  data.agents.find(
                    (a) =>
                      !a.retired_at &&
                      a.connection_id &&
                      belongsToProject(a.folder_id, id, data.folders),
                  );
                if (!agent) {
                  setFolder(id);
                  setSheet("create");
                  return;
                }
                setSelected(agent.id);
                setReplyContext(null);
                setContextArtifact(null);
                setFolder(id);
                setFolderChoice(undefined);
                focusComposer();
              }}
              onWorkflows={() => {
                setWorkflowId(undefined);
                setWorkflowSource(undefined);
                setSheet("workflows");
              }}
              onTeams={() => setSheet("teams")}
            />
          )}
          {dismissNotice && (
            <p className="note" role="status">
              {typeof dismissNotice === "string" ? (
                dismissNotice
              ) : (
                <>
                  {dismissNotice.text}{" "}
                  <button
                    className="text-button"
                    onClick={() => {
                      dismissNotice.onAction();
                      setDismissNotice("");
                    }}
                  >
                    {dismissNotice.action}
                  </button>
                </>
              )}
              <button
                className="icon-button"
                aria-label="Close notice"
                onClick={() => setDismissNotice("")}
              >
                <X size={16} />
              </button>
            </p>
          )}
        </main>
        {!conversation && messageComposer}
        <nav className="mobile-nav">{nav}</nav>
      </div>
      <Toasts />
      {archivedCard && (
        <div className="toast" role="status">
          <span>Archived from feed. Still in history and search.</span>
          <button onClick={() => void archiveCard(archivedCard, false)}>
            Undo
          </button>
          <button
            aria-label="Dismiss archive notice"
            onClick={() => setArchivedCard(null)}
          >
            ×
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="toast error">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {(sheet === "settings" || settingsParent) && (
        <Sheet
          title="Settings"
          className="side-panel settings-drawer"
          onClose={() => {
            setSettingsParent(false);
            setSheet("");
          }}
        >
          <div className="drawer-appearance">
            <span id="appearance-label">Appearance</span>
            <div
              className="drawer-segmented"
              role="group"
              aria-labelledby="appearance-label"
            >
              {(["system", "light", "dark"] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={theme === v}
                  onClick={() => setTheme(v)}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <nav className="drawer-links" aria-label="Settings pages">
            <h3>Connections</h3>
            <button onClick={() => openSettingsPage("connections")}>
              <LinkIcon size={20} aria-hidden="true" />
              Provider connections
            </button>
            <button onClick={() => openSettingsPage("environments")}>
              <Monitor size={20} aria-hidden="true" />
              Execution environments
            </button>
            <button onClick={() => openSettingsPage("runtime-hosts")}>
              <Server size={20} aria-hidden="true" />
              Runtime machines
            </button>
            <button onClick={() => openSettingsPage("mcp")}>
              <Plug size={20} aria-hidden="true" />
              Tools & integrations
            </button>
            <h3>Workspace</h3>
            <button onClick={() => openSettingsPage("agents")}>
              <Orbit size={20} aria-hidden="true" />
              Manage agents
            </button>
            <button onClick={() => openSettingsPage("memory")}>
              <Bookmark size={20} aria-hidden="true" />
              Shared memory
            </button>
            <button onClick={() => openSettingsPage("notifications")}>
              <Bell size={20} aria-hidden="true" />
              Notifications
            </button>
            {capabilities.nativeHarnesses && (
              <button onClick={() => openSettingsPage("native-history")}>
                <MessageSquare size={20} aria-hidden="true" />
                Native conversations
              </button>
            )}
            <button onClick={() => openSettingsPage("search-settings")}>
              <Search size={20} aria-hidden="true" />
              Search preferences
            </button>
            <button onClick={() => openSettingsPage("import")}>
              <Download size={20} aria-hidden="true" />
              Import conversations
            </button>
            <button onClick={() => openSettingsPage("install")}>
              <Smartphone size={20} aria-hidden="true" />
              Install on your phone
            </button>
          </nav>
          <footer className="drawer-account">
            <span className="avatar user" aria-hidden="true">
              {initials}
            </span>
            <span>
              <strong>{displayName}</strong>
              <small>Personal workspace</small>
            </span>
          {session.mode === "multi-user" && (
            <button
              className="text-button"
              onClick={async () => {
                stopEventsPoll.current();
                await api("/auth/sign-out", {});
                sessionStorage.clear();
                setTeamSelection([]);
                setArchivedCard(null);
                setComposerExpanded(false);
                setSharedDraft({
                  url: "",
                  title: "",
                  excerpt: "",
                  question: "",
                  folderId: "",
                });
                setActiveArtifact(null);
                setContextArtifact(null);
                setReplyContext(null);
                setRoutePreview(null);
                setFiling(null);
                setSheet("");
                history.replaceState({}, "", "/");
                setDraft("");
                setFolderChoice(undefined);
                setConversation(null);
                          setProfile(null);
                setSession(null);
                setData({ agents: [], connections: [], folders: [] });
                setItems([]);
                setRuns([]);
              }}
            >
              <LogOut size={18} />
              Sign out
            </button>
          )}
          </footer>
        </Sheet>
      )}
      {sheet === "agent-menu" && profile && (
        <ActionSheet
          title={"@" + profile.name}
          onClose={() => setSheet("")}
          actions={[
            {
              id: "edit",
              label: "Edit agent",
              hint: "Name, instructions and project",
              icon: <Settings size={20} />,
              onSelect: () => {
                setEditError("");
                setSheet("edit-agent");
              },
            },
            {
              id: "model",
              label: "Model, provider & effort",
              hint: agentModelName(profile, data.connections),
              icon: <SlidersHorizontal size={20} />,
              onSelect: () => setModelAgent(profile),
            },
            {
              id: "search",
              label: "Search this agent",
              icon: <Search size={20} />,
              onSelect: () => {
                setSearchAgent(profile.id);
                setSearchScope("all");
                setProfile(null);
                setTab("search");
              },
            },
            {
              id: "retire",
              label: profile.retired_at ? "Restore agent" : "Retire agent",
              danger: !profile.retired_at,
              icon: <X size={20} />,
              onSelect: () => setSheet("retire-agent"),
            },
          ]}
        />
      )}
      {sendMenu && (
        <ActionSheet
          title="Send options"
          onClose={() => setSendMenu(false)}
          actions={[
            threadMode && threadWork?.steerable
              ? {
                  id: "steer",
                  label: "Steer current task",
                  hint: `Delivered to @${destination.agent} now, while it works`,
                  icon: <ArrowUp size={20} />,
                  onSelect: () => void send(),
                }
              : {
                  id: "now",
                  label: "Send now",
                  hint:
                    threadMode && threadWork
                      ? `@${destination.agent} can’t take messages mid-task, so this waits for the current task`
                      : steersActive
                        ? `Goes to @${destination.agent}’s current task, which it steers`
                        : undefined,
                  icon: <ArrowUp size={20} />,
                  onSelect: () => void send(),
                },
            {
              id: "queue",
              label: threadMode && threadWork ? "Queue after this task" : "Queue after current work",
              hint: "Held until the agent’s earlier work ends, and while it is paused. Edit, cancel or move it back to a draft until it starts.",
              icon: <Clock3 size={20} />,
              onSelect: () => void send({ queue: true }),
            },
            {
              id: "later",
              label: "Send later at a time…",
              hint: "Choose when. Edit or cancel it in Later → Scheduled.",
              icon: <AlarmClock size={20} />,
              onSelect: () =>
                setScheduleAt(localInputValue(Date.now() + 3600_000)),
            },
          ]}
        >
          <p className="send-destination">
            To <strong>@{destination.agent}</strong> ·{" "}
            <strong>{destination.project}</strong> · {destination.thread}
          </p>
        </ActionSheet>
      )}
      {scheduleAt !== null && (
        <Sheet title="Send later" onClose={() => setScheduleAt(null)}>
          <dl className="send-summary">
            <dt>To</dt>
            <dd>@{destination.agent}</dd>
            <dt>Project</dt>
            <dd>{destination.project}</dd>
            <dt>Thread</dt>
            <dd>{destination.thread}</dd>
            <dt>Message</dt>
            <dd className="send-summary-text">{preview(draft, 140)}</dd>
          </dl>
          <div className="chip-row" role="group" aria-label="Quick times">
            {laterChoices(Date.now())
              .filter((choice) => choice.condition === "time")
              .map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className="chip"
                  aria-pressed={
                    !!choice.dueAt &&
                    scheduleAt === localInputValue(choice.dueAt)
                  }
                  onClick={() => setScheduleAt(localInputValue(choice.dueAt!))}
                >
                  {choice.label}
                </button>
              ))}
          </div>
          <label>
            Send at (your time,{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone})
            <input
              type="datetime-local"
              value={scheduleAt}
              min={localInputValue(Date.now())}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </label>
          <p className="field-hint">
            Loop sends it once, at that time, to the agent above. If it can’t be
            sent then, it stays in Needs you and Later → Scheduled with the
            reason, and is never retried on its own. This is not a reminder:
            use Remind me to bring something back to yourself.
          </p>
          <button
            className="primary"
            disabled={!scheduleAt || busy}
            onClick={() => {
              const at = new Date(scheduleAt).getTime();
              if (!(at > Date.now())) {
                setComposerError("Choose a time in the future.");
                setScheduleAt(null);
                return;
              }
              setScheduleAt(null);
              void send({ sendAt: at });
            }}
          >
            <AlarmClock size={17} /> Schedule for{" "}
            {scheduleAt && new Date(scheduleAt).getTime() > 0
              ? `${dayLabel(new Date(scheduleAt).getTime()).toLowerCase()} at ${timeLabel(new Date(scheduleAt).getTime())}`
              : "…"}
          </button>
        </Sheet>
      )}
      {laterCard && (
        <LaterSheet
          kind="artifact"
          targetId={laterCard.id}
          title={laterCard.title}
          onClose={() => setLaterCard(null)}
          onDone={(label, created) =>
            notify({
              text: `Reminder set: ${label.toLowerCase()}.`,
              link: {
                label: "View",
                onSelect: () => openLater("reminders", created.id),
              },
              undo: () => undoReminder(created),
            })
          }
        />
      )}
      {sheet === "notifications" && (
        <Sheet title="Notifications" onClose={closeSheet}>
          <Notifications />
        </Sheet>
      )}
      {sheet === "retire-agent" && profile && (
        <RetireAgent
          agent={profile}
          onClose={closeSheet}
          onChanged={(agent) => {
            setProfile(agent);
            setData((old) => ({
              ...old,
              agents: old.agents.map((a) => (a.id === agent.id ? agent : a)),
            }));
            if (agent.retired_at && selected === agent.id) {
              setSelected("");
              setReplyContext(null);
              setContextArtifact(null);
            }
            setSheet("");
            setDismissNotice(
              agent.retired_at
                ? "Agent retired. Its history is still available."
                : "Agent restored.",
            );
          }}
        />
      )}
      {sheet === "share" && (
        <ShareSheet
          draft={sharedDraft}
          setDraft={setSharedDraft}
          folders={data.folders}
          agents={data.agents}
          newAgentId={shareAgent}
          onClose={closeSheet}
          onCreate={() => {
            setReturnTo("share");
            setSheet("create");
          }}
          onSent={(r) => {
            setSharedDraft({
              url: "",
              title: "",
              excerpt: "",
              question: "",
              folderId: "",
            });
            setShareAgent(undefined);
            setSheet("");
            setConversation(r.conversation_id);
            void refresh();
          }}
        />
      )}
      {sheet === "install" && (
        <InstallHelp
          personal={session.mode === "single-user"}
          onClose={closeSheet}
        />
      )}
      {sheet === "workflows" && (
        <WorkflowEditor
          agents={data.agents}
          folders={data.folders}
          initialId={workflowId}
          initialSource={workflowSource}
          onCreateAgent={(source, id) => {
            setWorkflowSource(source);
            setWorkflowId(id);
            setReturnTo("workflows");
            setSheet("create");
          }}
          onClose={closeSheet}
          onStarted={() => {
            setTab("inbox");
            setInboxFilter("working");
            void changed();
          }}
          onConversation={(c) => {
            setSettingsParent(false);
            setSheet("");
            setConversation(c);
          }}
        />
      )}
      {sheet === "connections" && (
        <Connections
          connections={data.connections}
          onChange={async () => {
            await bootstrap();
          }}
          onClose={() => (returnTo ? setSheet("create") : closeSheet())}
        />
      )}
      {sheet === "create" && (
        <CreateAgent
          initialFolder={folder}
          initialPromptText={newAgentPrompt}
          connections={data.connections}
          folders={data.folders}
          onConnectionsChanged={bootstrap}
          onClose={closeSheet}
          onConnect={() => {
            setSheet("connections");
            if (!returnTo) setReturnTo("create");
          }}
          onCreated={async (a, f) => {
            if (newAgentPrompt) {
              setNewAgentPrompt("");
              setDraft("");
            }
            await bootstrap();
            setSelected(a.id);
            setFolder(f);
            if (returnTo === "share") {
              setShareAgent(a.id);
              setSheet("share");
            } else
              setSheet(
                ["workflows", "teams"].includes(returnTo) ? returnTo : "",
              );
            if (
              a.initialRun?.conversation_id &&
              !["share", "workflows", "teams"].includes(returnTo)
            ) {
              setTeamSelection([]);
              setProfile(null);
              setTab("inbox");
              setContextArtifact(null);
              setConversation(a.initialRun.conversation_id);
            }
            setReturnTo("");
          }}
        />
      )}
      {sheet === "runtime-hosts" && <RuntimeHosts onClose={closeSheet} />}
      {sheet === "environments" && (
        <ExecutionEnvironments
          folders={data.folders}
          onClose={closeSheet}
          onChange={() => void api("/bootstrap").then(setData)}
          onLegacy={() => setSheet("runtime-hosts")}
        />
      )}
      {sheet === "memory" && (
        <Memory folders={data.folders} onClose={closeSheet} />
      )}
      {sheet === "teams" && (
        <CreateTeam
          agents={data.agents}
          onClose={closeSheet}
          onCreateAgent={() => {
            setReturnTo("teams");
            setSheet("create");
          }}
          onCreated={(team) => {
            setSettingsParent(false);
            setSheet("");
            setTeamSelection([team.id]);
            setSelected(team.manager_id);
            setContextArtifact(null);
            setTab("inbox");
            setConversation(team.conversation_id);
            void bootstrap();
          }}
        />
      )}
      {sheet === "mcp" && <Tools onClose={closeSheet} />}
      {sheet === "agents" && (
        <AgentDirectory
          agents={data.agents}
          scopedIds={scopedAgents.map((a) => a.id)}
          folders={data.folders}
          onClose={closeSheet}
          onCreate={() => {
            setFolder(projectFilter);
            setSheet("create");
          }}
          onAgent={(a) => {
            setSettingsParent(false);
            setSheet("");
            setProfile(a);
            afterSheetsClose(() =>
              window.scrollTo({ top: 0, behavior: "instant" }),
            );
          }}
        />
      )}
      {modelAgent && (
        <AgentModelSettings
          agent={modelAgent}
          connections={data.connections}
          onClose={() => setModelAgent(null)}
          onSaved={(saved) => {
            if (saved.connection_id !== modelAgent.connection_id) {
              setContextArtifact(null);
              if (
                replyContext?.agentId === saved.id ||
                conversationTarget?.agentId === saved.id
              ) {
                setReplyContext(null);
                setConversation(null);
                setComposerExpanded(true);
              }
            }
            if (profile?.id === saved.id) setProfile(saved);
            setModelAgent((current) =>
              current?.id === saved.id ? saved : current,
            );
            setData((old) => ({
              ...old,
              agents: old.agents.map((agent) =>
                agent.id === saved.id ? saved : agent,
              ),
              teams:
                saved.connection_id !== modelAgent.connection_id
                  ? old.teams?.map((team) =>
                      team.manager_id === saved.id
                        ? { ...team, conversation_id: null }
                        : team,
                    )
                  : old.teams,
            }));
            void bootstrap();
          }}
        />
      )}
      {sheet === "edit-agent" && profile && (
        <Sheet title="Edit agent" onClose={closeSheet}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (editBusy) return;
              setEditBusy(true);
              setEditError("");
              const f = new FormData(e.currentTarget);
              try {
                const a = await api<Agent>(
                  "/agents/" + profile.id,
                  {
                    name: f.get("name"),
                    instructions: f.get("instructions"),
                    folderId: f.get("folder") || null,
                  },
                  "PATCH",
                );
                setProfile(a);
                await bootstrap();
                setSheet("");
                setDismissNotice("Agent changes saved.");
              } catch (e) {
                setEditError((e as Error).message);
              } finally {
                setEditBusy(false);
              }
            }}
          >
            <label>
              Unique name
              <input name="name" defaultValue={profile.name} />
            </label>
            <label>
              Agent instructions
              <textarea
                name="instructions"
                defaultValue={profile.instructions}
                maxLength={12000}
              />
            </label>
            <p className="field-hint">
              Guidance for every future task, such as the agent’s role, focus,
              or writing style.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => setModelAgent(profile)}
            >
              Model, provider & effort
            </button>
            <p className="note">
              Past outputs and running tasks retain their original provider and
              model.
            </p>
            <label>
              Project
              <select
                name="folder"
                aria-label="Project"
                defaultValue={profile.folder_id || ""}
              >
                <option value="">Workspace</option>
                {data.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            {editError && (
              <p className="error" role="alert">
                {editError}
              </p>
            )}
            <button className="primary" disabled={editBusy}>
              {editBusy ? "Saving…" : "Save changes"}
            </button>
          </form>
        </Sheet>
      )}
      {sheet === "native-history" && (
        <NativeHistory
          onClose={closeSheet}
          onOpen={(id) => {
            // Opening a thread leaves Settings, which this can be opened from.
            setSettingsParent(false);
            setSheet("");
            setConversation(id);
            void bootstrap();
          }}
        />
      )}
      {conversation && (
        <Conversation
          key={conversation}
          id={conversation}
          messageId={messageId}
          revision={revision}
          onAgentChanged={() => void bootstrap()}
          onNewConversation={(agent) => {
            setConversation(null);
            setSelected(agent.id);
            setContextArtifact(null);
            setReplyContext(null);
            setComposerExpanded(true);
          }}
          onProfile={(a) => {
            setConversation(null);
            collapseComposer();
            if (!draft.trim() && !attachments.length) setReplyContext(null);
            setProfile(a);
            afterSheetsClose(() =>
              window.scrollTo({ top: 0, behavior: "instant" }),
            );
          }}
          agents={data.agents}
          connections={data.connections}
          teams={data.teams || []}
          folders={data.folders}
          onNotice={setDismissNotice}
          onShowLater={openLater}
          onWork={setThreadWork}
          onClose={() => {
            setConversation(null);
            setThreadNotice("");
            collapseComposer();
            if (!draft.trim() && !attachments.length) setReplyContext(null);
          }}
          onContinue={setConversation}
          composer={messageComposer}
          onReady={(context) => {
            setConversationTarget(context);
            setSelected(context.agentId);
            setFolderChoice(undefined);
            setContextArtifact(null);
            setReplyContext((current) =>
              current?.agentId === context.agentId &&
              current.conversationId === context.conversationId
                ? current
                : context,
            );
            const saved = threadDraft(context.conversationId);
            if (!draft.trim() && saved.text) setDraft(saved.text);
            if (!attachments.length && saved.files.length)
              setAttachments(saved.files);
          }}
          onReply={beginReply}
          onUsePrompt={(text) => {
            setDraft(text);
            focusComposer();
          }}
          onRestoreDraft={restoreToComposer}
          onWithdraw={withdrawToComposer}
          onSubmitted={refresh}
        />
      )}
      {activeArtifact && (
        <ArtifactViewer
          key={activeArtifact.id}
          item={activeArtifact}
          connections={data.connections}
          onProfile={(agent) => {
            setActiveArtifact(null);
            setConversation(null);
            setProfile(agent);
            afterSheetsClose(() =>
              window.scrollTo({ top: 0, behavior: "instant" }),
            );
          }}
          agent={data.agents.find(
            (agent) => agent.id === activeArtifact.agent_id,
          )}
          onClose={() => setActiveArtifact(null)}
          onFile={() => {
            setFiling(activeArtifact);
            setActiveArtifact(null);
          }}
          onConversation={() => {
            const message = parse<any>(activeArtifact.metadata, {}).messageId;
            setConversation(activeArtifact.conversation_id, message);
            setActiveArtifact(null);
          }}
          onChanged={() => void changed()}
          onReply={() => void replyToArtifact(activeArtifact)}
          onWorkflow={(source) => {
            setWorkflowSource(source);
            setWorkflowId(undefined);
            setActiveArtifact(null);
            setSheet("workflows");
          }}
          onRun={(text) => {
            setDraft(text);
            setActiveArtifact(null);
            focusComposer();
          }}
        />
      )}
      {filing && (
        <FileSheet
          item={filing}
          initialResult={filingResult}
          folders={data.folders}
          onClose={() => {
            setFiling(null);
            setFilingResult(null);
          }}
          onChanged={() => void changed()}
        />
      )}
      {(sheet === "project" || sheet === "folder-edit") && (
        <FolderForm
          kind={tab === "projects" ? "project" : "folder"}
          existing={
            sheet === "folder-edit"
              ? data.folders.find((f) => f.id === folder)
              : undefined
          }
          folders={data.folders}
          parent={folder}
          onClose={closeSheet}
          onCreated={(created) => {
            if (tab === "projects") {
              setProject(created.id);
              setFolder(created.id);
            }
            void changed();
          }}
        />
      )}
      {sheet === "import" && (
        <ImportSheet
          onClose={() => {
            closeSheet();
            void changed();
          }}
          onChange={() => void changed()}
        />
      )}
      {sheet === "search-settings" && (
        <SearchSettings connections={data.connections} onClose={closeSheet} />
      )}
    </div>
  );
}
