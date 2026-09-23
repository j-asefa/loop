import { FeedPager } from "./feed";
import {
  ShareSheet,
  InstallHelp,
  initialShare,
  type SharedDraft,
} from "./Sharing";
import { PwaStatus } from "./Pwa";
import { Tools } from "./Tools";
import { WorkflowEditor, Approvals } from "./Workflows";
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
} from "../shared/types";
import "./style.css";
type Bootstrap = {
  agents: Agent[];
  connections: Connection[];
  folders: FolderType[];
};
const tabs = [
  { id: "feed", label: "Feed", icon: Rows3 },
  { id: "running", label: "Running", icon: Activity },
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
    [conversation, setConversation] = useState<string | null>(
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
  const [searchAgent, setSearchAgent] = useState("");
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
  const feed = useRef(new FeedPager<any>());
  const feedContext = useRef("");
  feedContext.current = [session?.user?.id, profile?.id, view].join(":");
  const activeAgent =
    selected === "__route__"
      ? data.agents.find((a) => a.id === routePreview?.agent?.id)
      : data.agents.find((a) => a.id === selected) ||
        data.agents.find((a) => a.connection_id);
  const working = runs.filter((r) =>
    ["queued", "running", "pausing", "awaiting_approval", "paused"].includes(
      r.state,
    ),
  );
  async function changed() {
    setRevision((v) => v + 1);
    await refresh();
  }
  async function check() {
    const r = await fetch("/api/auth/get-session", { cache: "no-store" });
    setSession(await r.json());
  }
  async function bootstrap() {
    const owner = ownerRef.current;
    const result = await api("/bootstrap");
    if (owner && owner === ownerRef.current) setData(result);
  }
  async function loadRuns() {
    const owner = ownerRef.current;
    const result = await api<Run[]>("/runs");
    if (owner && owner === ownerRef.current) setRuns(result);
  }
  async function loadFeed(append = false, notify = true) {
    const owner = ownerRef.current,
      key = [owner, profile?.id, view].join(":");
    if (!owner || key !== feedContext.current) return;
    if (feed.current.key !== key) {
      setItems([]);
      setNext(null);
    }
    const query = () => {
      const q = new URLSearchParams({ view });
      if (profile) q.set("agent", profile.id);
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
    void check().catch(() =>
      setError("Could not reach Loop. Reload when you are back online."),
    );
    const expire = () => {
      setSession(null);
      setData({ agents: [], connections: [], folders: [] });
      setItems([]);
      setRuns([]);
      sessionStorage.clear();
      setDraft("");
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
  }, [session?.user?.id, profile?.id, view]);
  useEffect(() => {
    if (!session?.user) return;
    let cursor = 0;
    const timer = setInterval(async () => {
      try {
        const events = await api<any[]>("/events?after=" + cursor);
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
    return () => clearInterval(timer);
  }, [session?.user?.id, profile?.id, view]);
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
    if (!draft.trim()) return;
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
      const conversationId =
        contextArtifact?.agent_id === recipient.id
          ? contextArtifact.conversation_id || undefined
          : undefined;
      const signature = JSON.stringify([
        recipient.id,
        draft,
        folder,
        conversationId,
      ]);
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      const run = await api<Run>("/runs", {
        agentId: recipient.id,
        conversationId,
        input: draft,
        idempotencyKey: request.current.key,
        ...(folder ? { folderId: folder } : {}),
      });
      setDraft("");
      request.current = { signature: "", key: "" };
      setConversation(run.conversation_id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(item: Artifact) {
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
        </button>
      ))}
    </>
  );
  if (session === undefined)
    return (
      <div className="loading">
        <Orbit className="spin" />
        <p>{error || "Opening your workspace…"}</p>
      </div>
    );
  if (!session?.user) return <Auth onDone={() => void check()} />;
  return (
    <div className="app-shell">
      <PwaStatus />
      <aside className="sidebar">
        <button
          className="wordmark"
          onClick={() => {
            setTab("feed");
            setProfile(null);
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
            onClick={() => setSheet("project")}
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
                setTab("saved");
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
            <button
              className="text-button"
              onClick={() => {
                setSharedDraft((d) => ({
                  ...d,
                  question: d.question || draft,
                  folderId: d.folderId || folder,
                }));
                setSheet("share");
              }}
            >
              <LinkIcon size={18} />
              <span>Bring a link</span>
            </button>
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
          {profile ? (
            <>
              <button className="text-button" onClick={() => setProfile(null)}>
                <ArrowLeft size={16} />
                Back to feed
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
                    document
                      .querySelector<HTMLTextAreaElement>("#composer")
                      ?.focus();
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
                  {working.filter((r) => r.agent_id === profile.id).length}{" "}
                  pending tasks in this agent’s queue
                </p>
              </section>
              <div className="segmented">
                {[
                  ["all", "Outputs"],
                  ["prompts", "Your prompts"],
                  ["files", "Files"],
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
                        : "Saved"}
                </h1>
              </div>
              <button className="secondary" onClick={() => setSheet("create")}>
                <Plus size={18} />
                <span>New agent</span>
              </button>
            </div>
          )}
          {tab === "feed" && !profile && (
            <>
              <div className="agent-strip">
                {data.agents.slice(0, 7).map((a) => (
                  <button key={a.id} onClick={() => setProfile(a)}>
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
                    : "All caught up"}
                </span>
              </div>
            </>
          )}
          {(tab === "feed" || profile) && (
            <div className="feed">
              {items.length ? (
                items.map((item) =>
                  item.role ? (
                    <article key={item.id} className="feed-card prompt-card">
                      <span className="eyebrow">You → @{item.name}</span>
                      <p>{item.content}</p>
                      <button
                        className="text-button"
                        onClick={() => {
                          setConversation(item.conversation_id);
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
                      project={
                        data.folders.find((f) => f.id === item.folder_id)
                          ?.name || "Workspace inbox"
                      }
                      onOpen={() => open(item)}
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
                          ? document
                              .querySelector<HTMLTextAreaElement>("#composer")
                              ?.focus()
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
              <Approvals revision={revision} onChange={() => void changed()} />
              <div className="segmented">
                {[
                  ["all", "All"],
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
              {runs.length ? (
                runs
                  .filter(
                    (r) =>
                      runFilter === "all" ||
                      (runFilter === "queued"
                        ? r.state === "queued"
                        : [
                            "paused",
                            "awaiting_approval",
                            "interrupted",
                            "failed",
                          ].includes(r.state)),
                  )
                  .map((r) => {
                    const a = data.agents.find((a) => a.id === r.agent_id),
                      snapshot = parse<any>(r.payload, {});
                    return (
                      <article key={r.id} className="run-card">
                        <div className="card-byline">
                          <div className="identity">
                            <Avatar name={a?.name} provider={a?.provider} />
                            <div>
                              <strong>
                                {a?.name ? "@" + a.name : r.input}
                              </strong>
                              <div className="subline">
                                <Badge
                                  provider={snapshot.provider || a?.provider}
                                />
                                <span>{snapshot.model}</span>
                              </div>
                            </div>
                          </div>
                          <span className={"status " + r.state}>
                            {r.state.replaceAll("_", " ")}
                          </span>
                        </div>
                        <h3>{r.input}</h3>
                        <p className="field-hint">
                          {Math.floor((Date.now() - r.created_at) / 60000)} min
                          since submitted
                          {r.state === "queued"
                            ? ` · position ${(r as any).queue_position} in this agent’s queue`
                            : ""}
                        </p>
                        {(r as any).stage && (
                          <p className="field-hint">
                            Stage: {(r as any).stage}
                          </p>
                        )}
                        {(r as any).preview && (
                          <p className="run-preview">{(r as any).preview}</p>
                        )}
                        {r.error && <p className="error">{r.error}</p>}
                        <div className="actions">
                          {["running", "queued"].includes(r.state) && (
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
                      </article>
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
                setConversation(c);
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
        </main>
        <section className="composer-dock">
          <div className="composer">
            <div className="composer-top">
              <select
                aria-label="Agent recipient"
                value={
                  selected === "__route__" ? "__route__" : activeAgent?.id || ""
                }
                onChange={(e) => setSelected(e.target.value)}
              >
                {!data.agents.length && (
                  <option value="">Choose your first agent</option>
                )}
                <option value="__route__">Let Loop route this</option>
                {data.agents.map((a) => (
                  <option value={a.id} key={a.id}>
                    @{a.name} · {a.provider}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                onClick={() => setSheet("create")}
                aria-label="Create an agent"
              >
                <Plus size={17} />
              </button>
              <select
                aria-label="Project"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="">Workspace inbox</option>
                {data.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
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
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="An idea, a question, a ‘what if’…"
                rows={2}
              />
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
                <ArrowUp size={23} />
              </button>
            </div>
            <div className="composer-foot">
              <span>
                {activeAgent ? (
                  <>
                    <Badge provider={activeAgent.provider} />
                    {activeAgent.model}
                  </>
                ) : (
                  "Start with a model. Make it your agent."
                )}
              </span>
              <button
                className="text-button"
                onClick={() => {
                  setWorkflowId(undefined);
                  setWorkflowSource(undefined);
                  setSheet("workflows");
                }}
              >
                Workflows
              </button>
            </div>
          </div>
        </section>
        <nav className="mobile-nav">{nav}</nav>
      </div>
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
            } else setSheet(returnTo === "workflows" ? "workflows" : "");
            setReturnTo("");
          }}
        />
      )}
      {sheet === "mcp" && (
        <Tools agents={data.agents} onClose={() => setSheet("")} />
      )}
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
          <button
            className="text-button"
            onClick={async () => {
              await api("/auth/sign-out", {});
              sessionStorage.clear();
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
              Instructions
              <textarea
                name="instructions"
                defaultValue={profile.instructions}
              />
            </label>
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
            <p className="note">
              Past outputs and running tasks retain their original provider and
              model.
            </p>
            <button className="primary">Save changes</button>
          </form>
        </Sheet>
      )}
      {conversation && (
        <Conversation
          id={conversation}
          agents={data.agents}
          onClose={() => {
            setConversation(null);
            history.replaceState({}, "", location.pathname);
          }}
          onContinue={setConversation}
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
            setConversation(activeArtifact.conversation_id);
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
          onCreated={() => void changed()}
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
