import { capabilities } from "./capabilities";
import { NativeHistory } from "./NativeHistory";
import { NativeDecisions, WorkspaceConnection } from "./NativeControls";
import { HarnessPicker } from "./HarnessPicker";
import { RunStatus } from "./RunStatus";
import { Projects } from "./Projects";
import { Traces } from "./Traces";
import { AgentMessages } from "./AgentMessages";
import { FeedPager } from "./feed";
import { TeamFilter, CreateTeam } from "./Teams";
import { RuntimeHosts } from "./RuntimeHosts";
import {
  ShareSheet,
  InstallHelp,
  initialShare,
  type SharedDraft,
} from "./Sharing";
import { PwaStatus } from "./Pwa";
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
  Saved,
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
      new URLSearchParams(location.search).has("folder") ? "saved" : "feed",
    ),
    [sheet, setSheet] = useState(
      new URLSearchParams(location.search).has("tools")
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
    [selected, setSelected] = useState(""),
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
  const [teamSelection, setTeamSelection] = useState<string[]>([]);
  const teamKey = [...teamSelection].sort().join(",");
  const [messageId, setMessageId] = useState<string | null>(
    new URLSearchParams(location.search).get("message"),
  );
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [project, setProject] = useState("");
  const [folderChoice, setFolderChoice] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("folder") ?? undefined,
  );
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissNotice, setDismissNotice] = useState("");
  const dismissLock = useRef(false);
  const [archivedCard, setArchivedCard] = useState<string | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  function setConversation(id: string | null, message?: string) {
    setMessageId(message || null);
    updateConversation(id);
    if (id)
      history.replaceState(
        history.state,
        "",
        "/?" +
          new URLSearchParams({
            conversation: id,
            ...(message ? { message } : {}),
          }),
      );
    else {
      const team =
        teamSelection.length === 1
          ? data.teams?.find((t) => t.id === teamSelection[0])
          : undefined;
      if (team) setSelected(team.manager_id);
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
  useEffect(() => {
    const outside = (e: PointerEvent) => {
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
  const [projectFilter, setProjectFilter] = useState("");
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);
  const [workflowSource, setWorkflowSource] = useState<string | undefined>(
    undefined,
  );
  const [filing, setFiling] = useState<Artifact | null>(null),
    [revision, setRevision] = useState(0),
    [runFilter, setRunFilter] = useState("all");
  const request = useRef({ signature: "", key: "" });
  const ownerRef = useRef<string | undefined>(undefined);
  ownerRef.current = session?.user?.id;
  const personalWorkspace = useRef(false);
  personalWorkspace.current = session?.mode === "single-user";
  const feed = useRef(new FeedPager<any>());
  const lastFeedTap = useRef(0);
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
        data.agents.find((a) => a.connection_id);
  const working = runs.filter((r) =>
    ["running", "pausing", "waiting_children"].includes(r.state),
  );
  const attention = runs.filter((r) =>
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
  async function bootstrap() {
    const owner = ownerRef.current;
    const result = await api("/bootstrap");
    if (owner && owner === ownerRef.current) setData(result);
  }
  const runsKey = useRef("");
  const runsGeneration = useRef(0);
  const runsScope = session?.user?.id + ":" + teamKey;
  const runsScopeRef = useRef(runsScope);
  runsScopeRef.current = runsScope;
  async function loadRuns() {
    const owner = ownerRef.current;
    const key = owner + ":" + teamKey;
    if (key !== runsScopeRef.current) return;
    runsKey.current = key;
    const generation = ++runsGeneration.current;
    const result = await api<Run[]>(
      "/runs?active=1&teams=" + encodeURIComponent(teamKey),
    );
    if (
      owner &&
      owner === ownerRef.current &&
      runsKey.current === key &&
      generation === runsGeneration.current &&
      key === runsScopeRef.current
    )
      setRuns(result);
  }
  async function loadFeed(append = false, notify = true) {
    const owner = ownerRef.current,
      key = [owner, profile?.id, view, teamKey, projectFilter].join(":");
    if (!owner || key !== feedContext.current) return;
    if (feed.current.key !== key) {
      setItems([]);
      setNext(null);
    }
    const query = () => {
      const q = new URLSearchParams({
        view: ["traces", "messages"].includes(view) ? "all" : view,
        teams: teamKey,
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
  }
  async function refresh() {
    await Promise.all([bootstrap(), loadFeed(), loadRuns()]);
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
      sessionStorage.clear();
      setTeamSelection([]);
      setArchivedCard(null);
      setComposerExpanded(false);
      setDraft("");
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
      setRoutePreview(null);
      setFiling(null);
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
    if (!capabilities.pairedDevices) {
      let cursor = 0;
      let cancelled = false;
      const timer = setInterval(async () => {
        try {
          const events = await api<any[]>("/events?after=" + cursor);
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
        } catch {}
      }, 1800);
      return () => {
        cancelled = true;
        clearInterval(timer);
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
  }, [session?.user?.id, profile?.id, view, teamKey]);
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
    if (busy || !draft.trim()) return;
    if (/^(put|move|file|organize)\b[\s\S]*\b(in|into|to)\b/i.test(draft)) {
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
          (!teamSelection.length || teamSelection.includes(t.id)),
      );
      const conversationId = managerTeam
        ? managerTeam.conversation_id
        : contextArtifact?.agent_id === recipient.id
          ? contextArtifact.conversation_id || undefined
          : teamSelection.length === 1 &&
              data.teams?.find((t) => t.id === teamSelection[0])?.manager_id ===
                recipient.id
            ? data.teams.find((t) => t.id === teamSelection[0])!.conversation_id
            : undefined;
      const signature = JSON.stringify([
        recipient.id,
        draft,
        folderChoice,
        conversationId,
      ]);
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      await api<Run>("/runs", {
        agentId: recipient.id,
        conversationId,
        input: draft,
        idempotencyKey: request.current.key,
        folderId:
          folderChoice !== undefined
            ? folderChoice || null
            : conversationId
              ? undefined
              : recipient.folder_id || undefined,
      });
      setDraft("");
      request.current = { signature: "", key: "" };
      collapseComposer();
      void refresh().catch((e) => setError(e.message));
    } catch (e) {
      setError((e as Error).message);
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
    if (profile) setView("messages");
  }, [profile?.id]);
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
          className={tab === t.id ? "current" : ""}
          onClick={() => {
            if (t.id === "feed") {
              const now = Date.now();
              if (tab === "feed" && now - lastFeedTap.current < 350)
                window.scrollTo({ top: 0, behavior: "smooth" });
              lastFeedTap.current = now;
            }
            setTab(t.id);
            setProfile(null);
            setView("all");
          }}
        >
          <t.icon size={21} />
          <span>{t.label}</span>
          {t.id === "running" && working.length > 0 && (
            <small>{working.length}</small>
          )}
          {t.id === "running" && attention.length > 0 && (
            <small
              className="attention-count"
              aria-label={`${attention.length} items need your attention`}
            >
              {attention.length}
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
                <p className="muted">{profile.model}</p>
                <p>{profile.instructions || "Ready for your next idea."}</p>
                <button
                  className="primary"
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
                <button
                  className="text-button"
                  onClick={() => setSheet("edit-agent")}
                >
                  Edit agent
                </button>
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
                <p className="field-hint">
                  {
                    runs.filter(
                      (r) => r.agent_id === profile.id && r.state === "queued",
                    ).length
                  }{" "}
                  pending tasks in this agent’s queue
                </p>
                {runs.filter(
                  (r) => r.agent_id === profile.id && r.state === "queued",
                ).length > 0 && (
                  <details className="agent-queue">
                    <summary>View pending tasks</summary>
                    <ol>
                      {runs
                        .filter(
                          (r) =>
                            r.agent_id === profile.id && r.state === "queued",
                        )
                        .sort(
                          (a, b) =>
                            ((a as any).queue_position || 0) -
                            ((b as any).queue_position || 0),
                        )
                        .map((r) => (
                          <li key={r.id}>
                            <button
                              className="text-button"
                              onClick={() =>
                                r.conversation_id &&
                                setConversation(r.conversation_id)
                              }
                            >
                              {r.input}
                            </button>
                            <small>Position {(r as any).queue_position}</small>
                          </li>
                        ))}
                    </ol>
                  </details>
                )}
              </section>
              <div className="segmented">
                {[
                  ["all", "Outputs"],
                  ["messages", "Messages"],
                  ["prompts", "Your prompts"],
                  ["files", "Files"],
                  ["traces", "Traces"],
                ].map(([v, label]) => (
                  <button
                    className={view === v ? "selected" : ""}
                    key={v}
                    onClick={() => setView(v)}
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
                    ? "Your loop."
                    : tab === "running"
                      ? "Running"
                      : tab === "search"
                        ? "Search everything."
                        : tab === "projects"
                          ? "Projects"
                          : "Saved"}
                </h1>
              </div>
              {tab !== "projects" && (
                <button
                  className="secondary"
                  onClick={() => setSheet("create")}
                >
                  <Plus size={18} />
                  <span>New agent</span>
                </button>
              )}
            </div>
          )}
          {["feed", "running"].includes(tab) && !profile && (
            <TeamFilter
              teams={data.teams || []}
              selected={teamSelection}
              onChange={(ids) => {
                setTeamSelection(ids);
                const team =
                  ids.length === 1
                    ? data.teams?.find((t) => t.id === ids[0])
                    : undefined;
                if (team) {
                  setSelected(team.manager_id);
                  setContextArtifact(null);
                }
              }}
              onCreate={() => setSheet("teams")}
              onOpen={(team) => {
                if (team) setConversation(team.conversation_id);
              }}
            />
          )}
          {["feed", "running"].includes(tab) && !profile && (
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
          )}
          {tab === "feed" && !profile && (
            <>
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
                    <small>
                      Review approvals and tasks that need a decision
                    </small>
                  </span>
                  <b>{attention.length}</b>
                  <ArrowUpRight size={20} />
                </button>
              )}
              <div className="agent-strip">
                {data.agents.slice(0, 7).map((a) => (
                  <button key={a.id} onClick={() => setProfile(a)}>
                    <small className="agent-strip-model" title={a.model}>
                      {a.model}
                    </small>
                    <Avatar name={a.name} provider={a.provider} />
                    <span>@{a.name}</span>
                  </button>
                ))}
                <button onClick={() => setSheet("create")}>
                  <span className="avatar add">
                    <Plus size={22} />
                  </span>
                  <span>New agent</span>
                </button>
              </div>
              <div className="feed-filters">
                <div className="segmented">
                  <button
                    className={view === "all" ? "selected" : ""}
                    onClick={() => setView("all")}
                  >
                    All activity
                  </button>
                  <button
                    className={view === "prompts" ? "selected" : ""}
                    onClick={() => setView("prompts")}
                  >
                    Your messages
                  </button>
                </div>
                <span className="muted">
                  {working.length
                    ? `${working.length} in progress`
                    : runs.some((r) => r.state === "queued")
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
            <AgentMessages agentId={profile.id} revision={revision}
              onConversation={setConversation} />
          )}
          {(tab === "feed" || profile) && !(profile && ["traces", "messages"].includes(view)) && (
            <div className="feed">
              {items.length ? (
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
                            data.agents.find((a) => a.name === item.name)?.id ||
                              "",
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
                      project={[
                        data.teams?.find((t) => t.id === item.team_id)?.name,
                        data.folders.find((f) => f.id === item.folder_id)
                          ?.name || "Workspace inbox",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      onOpen={() => openCard(item)}
                      onArtifact={() => void open(item)}
                      onArchive={() => void archiveCard(item.id)}
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
                    view === "prompts"
                      ? "Your ideas start here."
                      : "Your next idea belongs here."
                  }
                  action={
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
                  }
                >
                  A question, a half-formed thought, an ambitious plan. Give it
                  to an agent and watch the work take shape.
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
                    className={runFilter === v ? "selected" : ""}
                    onClick={() => setRunFilter(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {runs.filter((r) =>
                (!projectFilter ||
                  parse<any>(r.payload, {}).folderId === projectFilter) &&
                (runFilter === "all"
                  ? ["running", "pausing"].includes(r.state)
                  : runFilter === "queued"
                    ? r.state === "queued"
                    : [
                        "paused",
                        "awaiting_approval",
                        "interrupted",
                        "failed",
                        "waiting_children",
                      ].includes(r.state)),
              ).length ? (
                runs
                  .filter((r) =>
                    (!projectFilter ||
                      parse<any>(r.payload, {}).folderId === projectFilter) &&
                    (runFilter === "all"
                      ? ["running", "pausing"].includes(r.state)
                      : runFilter === "queued"
                        ? r.state === "queued"
                        : [
                            "paused",
                            "awaiting_approval",
                            "interrupted",
                            "failed",
                            "waiting_children",
                          ].includes(r.state)),
                  )
                  .map((r) => {
                    const a = data.agents.find((a) => a.id === r.agent_id),
                      snapshot = parse<any>(r.payload, {});
                    return (
                      <ArtifactCard
                        key={r.id}
                        className="run-card"
                        label={r.state.replaceAll("_", " ")}
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
                          r.conversation_id &&
                          setConversation(r.conversation_id)
                        }
                        headerActions={
                          !["running", "pausing"].includes(r.state) && (
                            <button
                              className="icon-button dismiss-attention"
                              aria-label={`Dismiss task: ${r.input}`}
                              title={
                                ["failed", "interrupted"].includes(r.state)
                                  ? "Dismiss from attention"
                                  : "Dismiss and cancel task"
                              }
                              disabled={dismissing !== null}
                              onClick={() => void dismiss(r)}
                            >
                              <X size={20} />
                            </button>
                          )
                        }
                        detail={
                          <p className="field-hint">
                            {Math.floor((Date.now() - r.created_at) / 60000)}{" "}
                            min since submitted
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
                history.replaceState(
                  {},
                  "",
                  `/?conversation=${c}${m ? "&message=" + m : ""}`,
                );
                setConversation(c, m);
              }}
            />
          )}
          {tab === "saved" && !profile && (
            <Saved
              folders={data.folders}
              folder={folder}
              onFolder={setFolder}
              onOpen={open}
              onFile={setFiling}
              onCreate={() => setSheet("project")}
              onEdit={() => setSheet("folder-edit")}
              version={revision}
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
              onFiles={(id) => {
                setFolder(id);
                setTab("saved");
              }}
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
        <section
          ref={composerRef}
          className={
            "composer-dock " + (composerExpanded ? "expanded" : "collapsed")
          }
        >
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
                  ? "Continue your draft…"
                  : activeAgent
                    ? "Message @" + activeAgent.name + "…"
                    : "Message an agent…"}
              </span>
              <Plus size={18} />
            </button>
          )}
          <div className="composer" hidden={!composerExpanded}>
            <div className="composer-heading">
              <strong>New message</strong>
              <button
                className="composer-collapse text-button"
                onClick={collapseComposer}
                aria-label="Collapse composer"
              >
                <ChevronDown size={18} /> Minimize
              </button>
            </div>
            <div className="composer-top">
              <label className="composer-field">
                <span>Send to</span>
                <select
                  aria-label="Agent recipient"
                  value={
                    selected === "__route__"
                      ? "__route__"
                      : activeAgent?.id || ""
                  }
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setFolderChoice(undefined);
                    const agent = data.agents.find(
                      (a) => a.id === e.target.value,
                    );
                    if (agent) setFolder(agent.folder_id || "");
                  }}
                >
                  {!data.agents.length && (
                    <option value="">Choose your first agent</option>
                  )}
                  <option value="__route__">Let Loop route this</option>
                  {data.agents.map((a) => (
                    <option value={a.id} key={a.id}>
                      @{a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="composer-field">
                <span>Project</span>
                <select
                  aria-label="Project"
                  value={
                    folderChoice ??
                    (contextArtifact?.agent_id === activeAgent?.id
                      ? contextArtifact?.folder_id || ""
                      : activeAgent?.folder_id || "")
                  }
                  onChange={(e) => {
                    setFolder(e.target.value);
                    setFolderChoice(e.target.value);
                  }}
                >
                  <option value="">Workspace inbox</option>
                  {data.folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selected === "__route__" && routePreview && (
              <p className="route-preview">
                {routePreview.agent
                  ? "Recipient: @" + routePreview.agent.name + " · "
                  : ""}
                {routePreview.reason}
              </p>
            )}
            {contextArtifact && (
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
                aria-label="Message your agent"
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
            <div className="composer-foot">
              <HarnessPicker
                agentId={selected === "__route__" ? undefined : activeAgent?.id}
                value={draft}
                onChange={setDraft}
                focusInput={() => document.getElementById("composer")?.focus()}
              />
              <span className="composer-model">
                {activeAgent ? (
                  <>
                    <Badge provider={activeAgent.provider} />
                    <span title={activeAgent.model}>{activeAgent.model}</span>
                  </>
                ) : (
                  "Start with a model. Make it your agent."
                )}
              </span>
            </div>
            <div className="composer-actions">
              <button
                className="composer-action"
                onClick={() => setSheet("create")}
                aria-label="Create an agent"
              >
                <Plus size={17} /> Agent
              </button>
              <button
                className="composer-action"
                onClick={() => {
                  setWorkflowId(undefined);
                  setWorkflowSource(undefined);
                  setSheet("workflows");
                }}
              >
                Workflows
              </button>
              <button
                className="send-button"
                aria-label={
                  selected === "__route__" && !routePreview
                    ? "Preview route"
                    : "Send message"
                }
                disabled={busy || !draft.trim()}
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
      {sheet === "share" && (
        <ShareSheet
          draft={sharedDraft}
          setDraft={setSharedDraft}
          folders={data.folders}
          agents={data.agents}
          newAgentId={shareAgent}
          onClose={() => setSheet("")}
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
      {sheet === "install" && <InstallHelp onClose={() => setSheet("")} />}
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
          onClose={() => setSheet("")}
          onStarted={() => {
            setTab("running");
            void changed();
          }}
          onConversation={(c) => {
            setSheet("");
            setConversation(c);
          }}
        />
      )}
      {sheet === "connections" && (
        <Connections
          connections={data.connections}
          onChange={bootstrap}
          onClose={() => setSheet(returnTo ? "create" : "")}
        />
      )}
      {sheet === "create" && (
        <CreateAgent
          initialFolder={folder}
          connections={data.connections}
          folders={data.folders}
          onClose={() => setSheet("")}
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
      {sheet === "runtime-hosts" && (
        <RuntimeHosts onClose={() => setSheet("")} />
      )}
      {sheet === "teams" && (
        <CreateTeam
          agents={data.agents}
          onClose={() => setSheet("")}
          onCreateAgent={() => {
            setReturnTo("teams");
            setSheet("create");
          }}
          onCreated={(team) => {
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
      {sheet === "mcp" && <Tools onClose={() => setSheet("")} />}
      {sheet === "settings" && (
        <Sheet title="Make Loop yours" onClose={() => setSheet("")}>
          <button className="text-button" onClick={() => setSheet("install")}>
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
                className={theme === v ? "selected" : ""}
                onClick={() => setTheme(v)}
              >
                <I size={20} />
                {v}
              </button>
            ))}
          </div>
          <div className="settings-links">
            <button onClick={() => setSheet("runtime-hosts")}>
              <Monitor size={20} />
              <span>
                Runtime machines<small>Run agents on your remote machine</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => setSheet("teams")}>
              <Orbit size={20} />
              <span>
                Agent teams<small>Create a manager and worker feed</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button
              onClick={() => {
                setWorkflowId(undefined);
                setWorkflowSource(undefined);
                setSheet("workflows");
              }}
            >
              <Orbit size={20} />
              <span>
                Workflows<small>Connect agents into an executable plan</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => setSheet("search-settings")}>
              <Search size={20} />
              <span>
                Search preferences
                <small>Control semantic indexing and data flow</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => setSheet("connections")}>
              <LinkIcon size={20} />
              <span>
                Provider connections
                <small>OpenAI, Anthropic, and your accounts</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => setSheet("import")}>
              <MessageSquare size={20} />
              <span>
                Import conversations
                <small>Bring your past work into Loop</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={() => setSheet("mcp")}>
              <Plus size={20} />
              <span>
                Tools & integrations
                <small>Connect your agents to your workspace</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          </div>
          {session.mode === "multi-user" && (
            <button
              className="text-button"
              onClick={async () => {
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
        </Sheet>
      )}
      {sheet === "edit-agent" && profile && (
        <Sheet title="Edit agent" onClose={() => setSheet("")}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                const a = await api<Agent>(
                  "/agents/" + profile.id,
                  {
                    name: f.get("name"),
                    instructions: f.get("instructions"),
                    model: f.get("model"),
                    effort: f.get("effort") || null,
                    folderId: f.get("folder") || null,
                  },
                  "PATCH",
                );
                setProfile(a);
                await bootstrap();
                setSheet("");
              } catch (e) {
                setError((e as Error).message);
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
            <label>
              Future model
              <select name="model" defaultValue={profile.model}>
                {parse<any[]>(
                  data.connections.find((c) => c.id === profile.connection_id)
                    ?.models,
                  [],
                ).map((m) => (
                  <option key={m.id}>{m.id}</option>
                ))}
              </select>
            </label>
            {(profile.provider === "openai" ||
              profile.provider === "codex") && (
              <label>
                Reasoning effort
                <select name="effort" defaultValue={profile.effort || ""}>
                  <option value="">Provider default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
            )}
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
            <button className="primary">Save changes</button>
          </form>
        </Sheet>
      )}
      {sheet === "native-history" && (
        <NativeHistory
          onClose={() => setSheet("")}
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
          onAgentChanged={() => void bootstrap()}
          onProfile={(a) => {
            setConversation(null);
            setProfile(a);
          }}
          agents={data.agents}
          connections={data.connections}
          teams={data.teams || []}
          onClose={() => {
            setConversation(null);
            history.replaceState({}, "", location.pathname);
          }}
          onContinue={setConversation}
          onSent={() => {
            setConversation(null);
            collapseComposer();
            void refresh().catch((e) => setError(e.message));
          }}
          onSubmitted={refresh}
          onError={setError}
        />
      )}
      {activeArtifact && (
        <ArtifactViewer
          item={activeArtifact}
          folders={data.folders}
          onClose={() => setActiveArtifact(null)}
          onFile={() => {
            setFiling(activeArtifact);
            setActiveArtifact(null);
          }}
          onConversation={() => {
            const message = parse<any>(activeArtifact.metadata, {}).messageId;
            history.replaceState(
              {},
              "",
              "/?conversation=" +
                activeArtifact.conversation_id +
                (message ? "&message=" + message : ""),
            );
            setConversation(activeArtifact.conversation_id, message);
            setActiveArtifact(null);
          }}
          onChanged={() => void changed()}
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
          existing={
            sheet === "folder-edit"
              ? data.folders.find((f) => f.id === folder)
              : undefined
          }
          folders={data.folders}
          parent={folder}
          onClose={() => setSheet("")}
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
            setSheet("");
            void changed();
          }}
          onChange={() => void changed()}
        />
      )}
      {sheet === "search-settings" && (
        <SearchSettings
          connections={data.connections}
          onClose={() => setSheet("")}
        />
      )}
    </div>
  );
}
