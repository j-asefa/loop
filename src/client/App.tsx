import { AgentModelSettings } from "./AgentModelSettings";
import { agentModelName, effortName, runModelName } from "./modelChoices";
import { AttachmentList, UploadButton, useAttachments } from "./Attachments";
import { MAX_MESSAGE_FILES } from "../shared/uploads";
import { capabilities } from "./capabilities";
import { NativeHistory } from "./NativeHistory";
import { NativeDecisions, WorkspaceConnection } from "./NativeControls";
import { HarnessPicker } from "./HarnessPicker";
import { RunStatus } from "./RunStatus";
import { AgentDirectory } from "./AgentDirectory";
import { YourAgents } from "./YourAgents";
import { AgentWork, currentAgentWork } from "./AgentWork";
import { agentStatusLine } from "./agentStatusLine";
import { AgentConversations } from "./AgentConversations";
import { belongsToProject } from "../shared/projects";
import { ProjectFiles } from "./ProjectFiles";
import { ProjectActivity } from "./ProjectActivity";
import { Projects } from "./Projects";
import { Traces } from "./Traces";
import { AgentMessages } from "./AgentMessages";
import { afterSheetsClose, closeTopSheet } from "./sheetHistory";
import { usePageHistory } from "./usePageHistory";
import { useSwipeBack } from "./useSwipeBack";
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
import { useEffect, useState, useRef, type ReactNode } from "react";
import {
  Orbit,
  Rows3,
  Activity,
  Search,
  Bookmark,
  Bell,
  Plus,
  ArrowUp,
  SlidersHorizontal,
  ChevronDown,
  Folder,
  Settings,
  Sun,
  Moon,
  Monitor,
  LogOut,
  MessageSquare,
  ArrowLeft,
  ArrowUpRight,
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
import { Conversation } from "./Conversation";
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
  { id: "feed", label: "Feed", icon: Rows3 },
  { id: "running", label: "Running", icon: Activity },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "search", label: "Search", icon: Search },
  { id: "saved", label: "Saved", icon: Bookmark },
];
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
    [tab, setTab] = useState(
      tabs.some(
        (t) => t.id === new URLSearchParams(location.search).get("page"),
      )
        ? new URLSearchParams(location.search).get("page")!
        : new URLSearchParams(location.search).has("folder")
          ? "saved"
          : "feed",
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
  const [failureRun, setFailureRun] = useState<Run | null>(null);
  const [routePreview, setRoutePreview] = useState<any>(null),
    [contextArtifact, setContextArtifact] = useState<Artifact | null>(null),
    [filingResult, setFilingResult] = useState<any>(null);
  const [teamSelection, setTeamSelection] = useState<string[]>(() =>
    (new URLSearchParams(location.search).get("teams") || "")
      .split(",")
      .filter(Boolean),
  );
  const teamKey = [...teamSelection].sort().join(",");
  const savedFeed = tab === "saved" && !profile;
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
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState("");
  useEffect(() => {
    sessionStorage.setItem("loop-draft-agent", selected);
  }, [selected]);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissNotice, setDismissNotice] = useState("");
  const [sendNotice, setSendNotice] = useState<{
    runId: string;
    conversationId: string | null;
    agentId: string;
    agentName: string;
    steering: boolean;
  } | null>(null);
  const dismissLock = useRef(false);
  const [archivedCard, setArchivedCard] = useState<string | null>(null);
  const composerRef = useRef<HTMLElement>(null);
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
  function collapseComposer() {
    document.querySelector<HTMLTextAreaElement>("#composer")?.blur();
    setComposerExpanded(false);
  }
  function beginReply(context: ComposerContext, text?: string) {
    setConversation(null);
    setActiveArtifact(null);
    setContextArtifact(null);
    setReplyContext(context);
    setSelected(context.agentId);
    setFolderChoice(undefined);
    setComposerError("");
    const url = new URL(location.href);
    url.searchParams.delete("artifact");
    history.replaceState(history.state, "", url.pathname + url.search);
    if (text !== undefined) setDraft(text);
    else if (!draft.trim()) {
      const previous =
        (context.messageId &&
          sessionStorage.getItem("loop-message-reply-" + context.messageId)) ||
        (context.artifactId &&
          sessionStorage.getItem("loop-result-reply-" + context.artifactId));
      if (previous) setDraft(previous);
    }
    setComposerExpanded(true);
    afterSheetsClose(focusComposer);
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
      afterSheetsClose(() =>
        window.scrollTo({ top: scroll, behavior: "instant" }),
      );
    },
  );
  useSwipeBack(Boolean(session?.user), () => {
    if (closeTopSheet() || previousPage()) return true;
    if (profile) {
      setProfile(null);
      setView("all");
    } else if (tab === "projects" && project) setProject("");
    else if (tab !== "feed") {
      setTab("feed");
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
      page: tab === "feed" ? "" : tab,
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
  }, [tab, projectFilter, teamKey, project]);
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);
  const [workflowSource, setWorkflowSource] = useState<string | undefined>(
    undefined,
  );
  const [filing, setFiling] = useState<Artifact | null>(null),
    [revision, setRevision] = useState(0),
    [runFilter, setRunFilter] = useState("all");
  const request = useRef(
    parse<{ signature: string; key: string }>(
      sessionStorage.getItem("loop-draft-receipt") || "",
      { signature: "", key: "" },
    ),
  );
  const ownerRef = useRef<string | undefined>(undefined);
  ownerRef.current = session?.user?.id;
  const personalWorkspace = useRef(false);
  const stopEventsPoll = useRef<() => void>(() => {});
  personalWorkspace.current = session?.mode === "single-user";
  const feed = useRef(new FeedPager<any>());
  const lastNavTap = useRef<{ tab: string; at: number } | null>(null);
  const feedContext = useRef("");
  feedContext.current = [
    session?.user?.id,
    profile?.id,
    view,
    teamKey,
    projectFilter,
    savedFeed,
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
  const visibleRuns = scopedRuns.filter((run) =>
    runFilter === "all"
      ? ["running", "pausing"].includes(run.state)
      : runFilter === "queued"
        ? run.state === "queued"
        : [
            "paused",
            "awaiting_approval",
            "interrupted",
            "failed",
            "waiting_children",
          ].includes(run.state),
  );
  const working = scopedRuns.filter((r) =>
    ["running", "pausing", "waiting_children"].includes(r.state),
  );
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
  async function dismiss(r: Run) {
    if (dismissLock.current) return;
    dismissLock.current = true;
    setDismissing(r.id);
    setError("");
    try {
      await api(`/runs/${r.id}/dismiss`, {});
      setRuns((old) => old.filter((item) => item.id !== r.id));
      setDismissNotice(
        ["failed", "interrupted"].includes(r.state)
          ? "Dismissed. The task’s history is still in its conversation."
          : "Dismissed and cancelled. The task’s history is still in its conversation.",
      );
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDismissing(null);
      dismissLock.current = false;
    }
  }
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
      key = [owner, profile?.id, view, teamKey, projectFilter, savedFeed].join(
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
            savedFeed || ["traces", "messages"].includes(view) ? "all" : view,
          ...(savedFeed ? { saved: "1" } : {}),
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
      setFailureRun(null);
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
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter, savedFeed]);
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
    savedFeed,
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
            loadFeed(false, events.length === 0),
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
  }, [session?.user?.id, profile?.id, view, teamKey, projectFilter, savedFeed]);
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
  async function send() {
    if (busy || uploading || !draft.trim()) return;
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
      if (request.current.signature !== signature) {
        // A conversation draft from the previous composer may be retrying a
        // response that was saved by the server but never acknowledged.
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
        request.current = {
          signature,
          key:
            previous.signature === previousSignature && previous.key
              ? previous.key
              : crypto.randomUUID(),
        };
      }
      sessionStorage.setItem(
        "loop-draft-receipt",
        JSON.stringify(request.current),
      );
      const accepted = await api<Run & { steeringId?: string }>("/runs", {
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
        sessionStorage.removeItem("loop-conversation-" + conversationId);
        sessionStorage.removeItem("loop-conversation-files-" + conversationId);
        sessionStorage.removeItem("loop-receipt-" + conversationId);
      }
      if (reply?.messageId)
        sessionStorage.removeItem("loop-message-reply-" + reply.messageId);
      if (reply?.artifactId)
        sessionStorage.removeItem("loop-result-reply-" + reply.artifactId);
      setReplyContext(null);
      setContextArtifact(null);
      if (conversation) setConversation(null);
      collapseComposer();
      void refresh().catch((e) => setError(e.message));
    } catch (e) {
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
  async function runAction(r: Run, action: string) {
    try {
      await api(`/runs/${r.id}/${action}`, {});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const nav = (
    <>
      {tabs.map((t) => (
        <button
          key={t.id}
          aria-label={t.label}
          aria-current={tab === t.id ? "page" : undefined}
          className={tab === t.id ? "current" : ""}
          onClick={() => {
            if (t.id === "feed" || t.id === "running") {
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
          <t.icon size={21} />
          <span>{t.label}</span>
          {t.id === "running" && runningAgentCount > 0 && (
            <small
              className="running-count"
              aria-label={`${runningAgentCount} ${runningAgentCount === 1 ? "agent" : "agents"} running`}
            >
              {runningAgentCount}
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
  const messageComposer =
    availableAgents.length > 0 ? (
      <section
        ref={composerRef}
        className={
          "composer-dock " + (composerExpanded ? "expanded" : "collapsed")
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
        {!composerExpanded && (
          <button
            className="composer-launch"
            onClick={focusComposer}
            aria-label="Compose a message"
            aria-expanded={false}
          >
            <MessageSquare size={20} />
            <span>
              {draft
                ? `Draft to @${activeAgent?.name || "agent"}…`
                : activeAgent
                  ? "Message @" + activeAgent.name + "…"
                  : "Message an agent…"}
            </span>
            <Plus size={18} />
          </button>
        )}
        <div className="composer" hidden={!composerExpanded}>
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
                  if (
                    conversation &&
                    e.target.value !== conversationTarget?.agentId
                  )
                    setConversation(null);
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
          {replyContext && (replyContext.content || !conversation) && (
            <div className="composer-reply-context">
              <div className="composer-context-heading">
                <span>Replying to @{activeAgent?.name}</span>
                <button
                  className="icon-button"
                  aria-label="Clear reply context"
                  onClick={() => setReplyContext(null)}
                >
                  <X size={16} />
                </button>
              </div>
              {replyContext.content && (
                <div
                  className="composer-quote"
                  role="region"
                  aria-label="Original message"
                  tabIndex={0}
                >
                  <RichText content={replyContext.content} compact />
                </div>
              )}
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
              onKeyDown={(e) => {
                if (e.key === "Escape") setComposerExpanded(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="An idea, a question, a ‘what if’…"
              rows={2}
            />
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
          <div className="composer-foot">
            <HarnessPicker
              conversationId={
                replyContext?.conversationId || (conversation ?? undefined)
              }
              agentId={selected === "__route__" ? undefined : activeAgent?.id}
              value={draft}
              onChange={setDraft}
              focusInput={() => document.getElementById("composer")?.focus()}
            />
          </div>
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
                    <small className="composer-effort">
                      {effortName(activeAgent.effort)} effort
                    </small>
                  </span>
                  <ChevronDown size={15} />
                </>
              ) : (
                "Select an agent"
              )}
            </button>
            <button
              className="send-button"
              aria-label={
                selected === "__route__" && !routePreview
                  ? "Preview route"
                  : replyContext || conversation
                    ? "Send reply"
                    : "Send message"
              }
              disabled={
                busy || uploading || !draft.trim() || !!activeAgent?.retired_at
              }
              onClick={() => void send()}
            >
              {busy
                ? "Sending…"
                : selected === "__route__" && !routePreview
                  ? "Preview"
                  : "Send"}
              <ArrowUp size={19} />
            </button>
          </div>
        </div>
      </section>
    ) : null;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="wordmark"
          onClick={() => {
            setTab("feed");
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
        <button
          className="sidebar-settings"
          onClick={() => setSheet("settings")}
        >
          <Settings size={19} />
          Settings & connections
        </button>
        <div className="user-row">
          <span className="avatar user">{session.user.name?.[0] || "J"}</span>
          <span>
            <strong>{session.user.name}</strong>
            <small>Personal workspace</small>
          </span>
        </div>
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
              className="icon-button"
              aria-label="Settings"
              onClick={() => setSheet("settings")}
            >
              <SlidersHorizontal size={20} />
            </button>
          </div>
        </header>
        <main className="workspace-content">
          {workspaceLoadError && (
            <div className="workspace-load-status note" role="status">
              <span>{workspaceLoadError} Retrying…</span>
              <button className="text-button" onClick={() => void refresh()}>
                Retry now
              </button>
            </div>
          )}
          {capabilities.pairedDevices && <WorkspaceConnection />}
          {capabilities.nativeHarnesses && (
            <button
              className="text-button"
              onClick={() => setSheet("native-history")}
            >
              Native conversations
            </button>
          )}
          {profile ? (
            <>
              <button
                className="text-button"
                onClick={() => {
                  setProfile(null);
                  setView("all");
                }}
              >
                <ArrowLeft size={16} />
                {tab === "projects" ? "Back to project" : "Back to feed"}
              </button>
              <section className="profile-head">
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
                    setTab("feed");
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
                      focusComposer();
                    }}
                  >
                    <MessageSquare size={16} />
                    Message
                  </button>
                  <AgentConversations
                    key={session.user.id + ":" + profile.id}
                    agent={profile}
                    teams={data.teams || []}
                    onOpen={(id) => {
                      setSelected(profile.id);
                      setConversation(id);
                    }}
                  />
                  <button
                    className="text-button"
                    onClick={() => {
                      setEditError("");
                      setSheet("edit-agent");
                    }}
                  >
                    Edit agent
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setSheet("retire-agent")}
                  >
                    {profile.retired_at ? "Restore agent" : "Retire agent"}
                  </button>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setSearchAgent(profile.id);
                    setProfile(null);
                    setTab("search");
                  }}
                >
                  Search this agent
                </button>
                <AgentWork
                  runs={profileWork}
                  onConversation={setConversation}
                />
              </section>
              <div className="segmented">
                {[
                  ["all", "Results"],
                  ["messages", "Messages"],
                  ["files", "Files"],
                  ["traces", "Traces"],
                  ["prompts", "Your prompts"],
                ].map(([v, label]) => (
                  <button
                    className={view === v ? "selected" : ""}
                    key={v}
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
          ) : (
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  {tab === "feed"
                    ? "Make something of your ideas"
                    : tab === "running"
                      ? "Work in motion"
                      : tab === "search"
                        ? "Less scrolling. More finding."
                        : "A home for your work"}
                </span>
                <h1>
                  {tab === "feed"
                    ? "Feed"
                    : tab === "running"
                      ? "Running"
                      : tab === "search"
                        ? "Search everything."
                        : tab === "projects"
                          ? "Projects"
                          : "Saved"}
                </h1>
                {tab === "feed" && (
                  <p className="page-description">
                    Your agents, their work, and what’s next.
                  </p>
                )}
              </div>
              {!["feed", "projects", "saved"].includes(tab) &&
                availableAgents.length > 0 && (
                  <button
                    className="secondary"
                    aria-label="New agent"
                    onClick={() => {
                      setFolder(projectFilter);
                      setSheet("create");
                    }}
                  >
                    <Plus size={18} />
                    <span>New agent</span>
                  </button>
                )}
            </div>
          )}
          {["feed", "running", "saved"].includes(tab) &&
            !profile &&
            data.agents.length > 0 && (
              <div className="workspace-scope">
                <TeamFilter
                  teams={data.teams || []}
                  selected={teamSelection}
                  onDeleted={(id) => {
                    setData((old) => ({
                      ...old,
                      teams: old.teams?.filter((team) => team.id !== id),
                    }));
                    setTeamSelection((old) =>
                      old.filter((team) => team !== id),
                    );
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
                <label className="project-feed-filter">
                  Project
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
                <TeamManagerShortcut
                  teams={data.teams || []}
                  agents={data.agents}
                  selected={teamSelection}
                  onOpen={messageTeam}
                />
              </div>
            )}
          {tab === "feed" && !profile && (
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
              {attention.length > 0 && (
                <button
                  className="attention-banner"
                  aria-label={`${attention.length} need attention`}
                  onClick={() => {
                    setTab("running");
                    setRunFilter("needs");
                  }}
                >
                  <CircleAlert size={25} />
                  <span>
                    <strong>Needs your attention</strong>
                    <small>Review tasks and approvals</small>
                  </span>
                  <b>{attention.length}</b>
                  <ArrowUpRight size={20} />
                </button>
              )}
              <div className="feed-filters">
                <div className="segmented">
                  <button
                    aria-pressed={view === "all"}
                    className={view === "all" ? "selected" : ""}
                    onClick={() => setView("all")}
                  >
                    Results
                  </button>
                  <button
                    aria-pressed={view === "prompts"}
                    className={view === "prompts" ? "selected" : ""}
                    onClick={() => setView("prompts")}
                  >
                    Your messages
                  </button>
                </div>
                <span className="muted">
                  {working.length
                    ? `${working.length} in progress`
                    : scopedRuns.some((r) => r.state === "queued")
                      ? "Work queued"
                      : attention.length
                        ? ""
                        : "All caught up"}
                </span>
              </div>
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
          {profile && view === "messages" && (
            <AgentMessages
              key={profile.id}
              agent={profile}
              revision={revision}
              onConversation={setConversation}
              onReply={beginReply}
            />
          )}
          {(tab === "feed" || savedFeed || profile) &&
            !(profile && ["traces", "messages"].includes(view)) && (
              <div className="feed">
                {feedError && items.length > 0 && (
                  <div className="error" role="alert">
                    {feedError}
                    <button
                      className="text-button"
                      onClick={() => void loadFeed()}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {feedLoading ? (
                  <div
                    className="feed-loading"
                    role="status"
                    aria-label="Loading activity"
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                ) : feedError && !items.length ? (
                  <div className="error" role="alert">
                    {feedError}
                    <button
                      className="text-button"
                      onClick={() => void loadFeed()}
                    >
                      Try again
                    </button>
                  </div>
                ) : items.length ? (
                  items.map((item) =>
                    item.role ? (
                      <article
                        key={item.id}
                        className="feed-card prompt-card"
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          setConversation(item.conversation_id, item.id)
                        }
                        onKeyDown={(e) => {
                          if (
                            e.target === e.currentTarget &&
                            ["Enter", " "].includes(e.key)
                          ) {
                            e.preventDefault();
                            setConversation(item.conversation_id, item.id);
                          }
                        }}
                      >
                        <span className="eyebrow">
                          You →{" "}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setProfile(
                                data.agents.find((a) => a.name === item.name) ||
                                  null,
                              );
                            }}
                          >
                            @{item.name}
                          </button>
                        </span>
                        <time className="field-hint">
                          {new Date(item.created_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </time>
                        <p>{item.content}</p>
                        <RunStatus
                          state={item.run_state}
                          error={item.run_error}
                        />
                        <button
                          className="text-button"
                          onClick={() => {
                            setConversation(item.conversation_id, item.id);
                            setSelected(
                              data.agents.find((a) => a.name === item.name)
                                ?.id || "",
                            );
                          }}
                        >
                          Open conversation
                          <ArrowUpRight size={15} />
                        </button>
                      </article>
                    ) : (
                      <ArtifactCard
                        key={item.id}
                        item={item}
                        connections={data.connections}
                        project={[
                          data.teams?.find((t) => t.id === item.team_id)?.name,
                          data.folders.find((f) => f.id === item.folder_id)
                            ?.name || "Workspace inbox",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        onOpen={() => openCard(item)}
                        onArtifact={() => void open(item)}
                        onReply={() => void replyToArtifact(item)}
                        onArchive={
                          savedFeed
                            ? undefined
                            : () => void archiveCard(item.id)
                        }
                        onProfile={() =>
                          setProfile(
                            data.agents.find((a) => a.id === item.agent_id) ||
                              null,
                          )
                        }
                        onFile={() => setFiling(item)}
                        onPin={async () => {
                          try {
                            await api(
                              "/artifacts/" + item.id,
                              { pinned: !item.pinned, version: item.version },
                              "PATCH",
                            );
                            await changed();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      />
                    ),
                  )
                ) : (
                  <Empty
                    title={
                      savedFeed
                        ? "No saved cards yet."
                        : profile
                          ? view === "prompts"
                            ? "Your prompts will appear here."
                            : view === "files"
                              ? "No files yet."
                              : "No results yet."
                          : projectFilter || teamSelection.length
                            ? "No activity in this view yet."
                            : view === "prompts"
                              ? "Your prompts will appear here."
                              : data.agents.length
                                ? "Ready for your next task."
                                : "Create your first agent."
                    }
                    action={
                      savedFeed ? undefined : (
                        <button
                          className="primary"
                          onClick={() =>
                            data.agents.length
                              ? focusComposer()
                              : setSheet("create")
                          }
                        >
                          <Plus size={17} />
                          {data.agents.length
                            ? "Start a conversation"
                            : "Create your first agent"}
                        </button>
                      )
                    }
                  >
                    {savedFeed
                      ? "Save a card with its bookmark button to keep it here. Your team and project filters also apply to Saved."
                      : profile
                        ? profileWork.length
                          ? "Your agent’s work is shown above. Open its conversation to follow along."
                          : "Send a message to this agent to get started."
                        : projectFilter || teamSelection.length
                          ? "Choose another project or team, or start a task here."
                          : "Choose a provider, give your agent a task, and find its finished work here."}
                  </Empty>
                )}
                {next && (
                  <button
                    className="secondary load-more"
                    onClick={() => void loadFeed(true)}
                  >
                    Earlier activity
                  </button>
                )}
              </div>
            )}
          {tab === "running" && !profile && (
            <div className="run-list">
              {capabilities.nativeHarnesses && (
                <NativeDecisions onConversation={setConversation} />
              )}
              <Approvals
                teams={teamKey}
                runIds={projectFilter ? scopedRuns.map((r) => r.id) : undefined}
                revision={revision}
                onChange={() => void changed()}
                onConversation={setConversation}
              />
              <div className="segmented">
                {[
                  ["all", "Executing"],
                  ["needs", "Needs you"],
                  ["queued", "Queued"],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    aria-pressed={runFilter === v}
                    className={runFilter === v ? "selected" : ""}
                    onClick={() => setRunFilter(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {visibleRuns.length ? (
                visibleRuns.map((r) => {
                  const a = data.agents.find((a) => a.id === r.agent_id),
                    snapshot = parse<any>(r.payload, {});
                  return (
                    <ArtifactCard
                      key={r.id}
                      connections={data.connections}
                      className="run-card"
                      label={r.state.replaceAll("_", " ")}
                      model={runModelName(snapshot, data.connections)}
                      item={{
                        id: r.id,
                        owner_id: "",
                        agent_id: r.agent_id,
                        conversation_id: r.conversation_id,
                        run_id: r.id,
                        title: r.input,
                        kind: "markdown",
                        content: (r as any).preview || "",
                        metadata: r.payload,
                        folder_id: snapshot.folderId || null,
                        pinned: 0,
                        archived: 0,
                        version: 1,
                        created_at: r.created_at,
                        updated_at: r.updated_at,
                        ...r.preview_artifact,
                        name: a?.name,
                        provider: snapshot.provider || a?.provider,
                        run_state: r.state,
                        run_error: r.error,
                      }}
                      project={
                        data.folders.find((f) => f.id === snapshot.folderId)
                          ?.name || "Workspace inbox"
                      }
                      onProfile={() => a && setProfile(a)}
                      onOpen={() =>
                        r.conversation_id && setConversation(r.conversation_id)
                      }
                      headerActions={
                        !["running", "pausing"].includes(r.state) && (
                          <button
                            className={
                              ["failed", "interrupted"].includes(r.state)
                                ? "icon-button dismiss-attention"
                                : "text-button dismiss-attention"
                            }
                            aria-label={`${["failed", "interrupted"].includes(r.state) ? "Dismiss" : "Cancel"} task: ${r.input}`}
                            title={
                              ["failed", "interrupted"].includes(r.state)
                                ? "Dismiss from attention"
                                : "Dismiss and cancel task"
                            }
                            disabled={dismissing !== null}
                            onClick={() => void dismiss(r)}
                          >
                            <X size={18} />
                            {!["failed", "interrupted"].includes(r.state) &&
                              "Cancel task"}
                          </button>
                        )
                      }
                      detail={
                        <p className="field-hint">
                          {Math.floor((Date.now() - r.created_at) / 60000)} min
                          since submitted
                          {r.state === "queued"
                            ? ` · position ${(r as any).queue_position} in this agent’s queue`
                            : ""}
                        </p>
                      }
                      footer={
                        <div className="actions">
                          {(r.state === "queued" ||
                            (r.state === "running" &&
                              !parse<any>(
                                data.connections.find(
                                  (c) => c.id === snapshot.connectionId,
                                )?.metadata,
                                {},
                              ).loopHarness)) && (
                            <button onClick={() => runAction(r, "pause")}>
                              <Pause size={16} />
                              Pause
                            </button>
                          )}
                          {r.state === "pausing" && (
                            <p className="note">
                              Pausing after the current provider response.
                            </p>
                          )}
                          {r.state === "paused" && (
                            <button onClick={() => runAction(r, "resume")}>
                              <Play size={16} />
                              Resume
                            </button>
                          )}
                          {!["completed", "failed", "cancelled"].includes(
                            r.state,
                          ) && (
                            <button onClick={() => runAction(r, "cancel")}>
                              <Square size={14} />
                              Cancel
                            </button>
                          )}
                          {["failed", "interrupted"].includes(r.state) &&
                            r.agent_id &&
                            (r as any).kind === "agent" && (
                              <button
                                onClick={async () => {
                                  try {
                                    await api(`/runs/${r.id}/retry`, {
                                      idempotencyKey: crypto.randomUUID(),
                                    });
                                    await refresh();
                                  } catch (e) {
                                    setError((e as Error).message);
                                  }
                                }}
                              >
                                Retry as a new run
                              </button>
                            )}
                          {["failed", "interrupted"].includes(r.state) &&
                            r.agent_id && (
                              <button onClick={() => setFailureRun(r)}>
                                View failure details
                              </button>
                            )}
                          {r.conversation_id && (
                            <button
                              onClick={() => {
                                setConversation(r.conversation_id);
                                setSelected(r.agent_id || "");
                              }}
                            >
                              <ArrowUpRight size={16} />
                              Open
                            </button>
                          )}
                        </div>
                      }
                    />
                  );
                })
              ) : (
                <Empty
                  title="Ready when you are."
                  action={
                    <button
                      className="primary"
                      onClick={() => setSheet("create")}
                    >
                      <Plus size={17} />
                      New agent
                    </button>
                  }
                >
                  Your agents keep working when you close Loop. Active tasks and
                  queued ideas will appear here.
                </Empty>
              )}
            </div>
          )}
          {tab === "search" && !profile && (
            <SearchWorkspace
              key={searchAgent}
              onSearchSettings={() => setSheet("search-settings")}
              onProfile={setProfile}
              initialAgent={searchAgent}
              agents={data.agents}
              folders={data.folders}
              onOpen={open}
              onConversation={(c, m) => {
                setConversation(c, m);
              }}
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
            />
          )}
          {dismissNotice && (
            <p className="note" role="status">
              {dismissNotice}
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
          onClose={() => {
            setSettingsParent(false);
            setSheet("");
          }}
        >
          <button
            className="text-button"
            onClick={() => openSettingsPage("install")}
          >
            Install & share on your phone
          </button>
          <h3>Appearance</h3>
          <div className="theme-picker">
            {[
              ["system", Monitor],
              ["light", Sun],
              ["dark", Moon],
            ].map(([v, I]: any) => (
              <button
                key={v}
                aria-pressed={theme === v}
                className={theme === v ? "selected" : ""}
                onClick={() => setTheme(v)}
              >
                <I size={20} />
                {v}
              </button>
            ))}
          </div>
          <h3>Connections</h3>
          <div className="settings-links">
            <button onClick={() => openSettingsPage("connections")}>
              <LinkIcon size={20} />
              <span>
                Provider connections
                <small>ChatGPT, Claude, and your API accounts</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("environments")}>
              <Monitor size={20} />
              <span>
                Execution environments<small>Native and Docker execution</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("runtime-hosts")}>
              <Monitor size={20} />
              <span>
                Runtime machines<small>Run agents on your remote machine</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          </div>
          <h3>Tools</h3>
          <div className="settings-links">
            <button onClick={() => openSettingsPage("mcp")}>
              <Plus size={20} />
              <span>
                Tools & integrations
                <small>Connect your agents to your workspace</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button
              onClick={() => {
                setWorkflowId(undefined);
                setWorkflowSource(undefined);
                openSettingsPage("workflows");
              }}
            >
              <Orbit size={20} />
              <span>
                Workflows<small>Connect agents into an executable plan</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          </div>
          <h3>Workspace</h3>
          <div className="settings-links">
            <button onClick={() => openSettingsPage("memory")}>
              <Bookmark size={20} />
              <span>
                Shared memory
                <small>Sources, notes and inclusion controls</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("teams")}>
              <Orbit size={20} />
              <span>
                Agent teams<small>Create a manager and worker feed</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("agents")}>
              <Orbit size={20} />
              <span>
                Manage agents<small>Active and retired agents</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("notifications")}>
              <Bell size={20} />
              <span>
                Result notifications
                <small>
                  Know when your agents finish, even with Loop closed
                </small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("search-settings")}>
              <Search size={20} />
              <span>
                Search preferences
                <small>Control semantic indexing and data flow</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => openSettingsPage("import")}>
              <MessageSquare size={20} />
              <span>
                Import conversations
                <small>Bring your past work into Loop</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          </div>
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
                setFailureRun(null);
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
        </Sheet>
      )}
      {sheet === "notifications" && (
        <Sheet title="Result notifications" onClose={closeSheet}>
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
            setTab("running");
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
          connections={data.connections}
          folders={data.folders}
          onConnectionsChanged={bootstrap}
          onClose={closeSheet}
          onConnect={() => {
            setSheet("connections");
            if (!returnTo) setReturnTo("create");
          }}
          onCreated={async (a, f) => {
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
              setTab("feed");
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
            setTab("feed");
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
      {failureRun?.agent_id && (
        <Sheet
          title="Run failure details"
          wide
          swipeToClose
          onClose={() => setFailureRun(null)}
        >
          <RunStatus state={failureRun.state} error={failureRun.error} />
          <p className="field-hint">
            Saved progress and tool activity for this attempt.
          </p>
          <Traces
            key={failureRun.id}
            agentId={failureRun.agent_id}
            runId={failureRun.id}
            revision={revision}
            onConversation={(id) => {
              setFailureRun(null);
              setConversation(id);
            }}
            onArtifact={(artifact) => {
              setFailureRun(null);
              setActiveArtifact(artifact);
            }}
          />
        </Sheet>
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
          onClose={() => {
            setConversation(null);
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
            setComposerExpanded(true);
            if (!draft.trim()) {
              const oldDraft = sessionStorage.getItem(
                "loop-conversation-" + context.conversationId,
              );
              if (oldDraft) setDraft(oldDraft);
            }
            if (!attachments.length) {
              const oldFiles = parse(
                sessionStorage.getItem(
                  "loop-conversation-files-" + context.conversationId,
                ) || "",
                [],
              );
              if (oldFiles.length) setAttachments(oldFiles);
            }
          }}
          onReply={beginReply}
          onUsePrompt={(text) => {
            setDraft(text);
            focusComposer();
          }}
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
