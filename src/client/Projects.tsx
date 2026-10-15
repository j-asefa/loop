import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  CircleDashed,
  FileText,
  Folder,
  Search,
  MessageSquarePlus,
  Plus,
  UserPlus,
  Pencil,
  Users,
  Workflow,
  SlidersHorizontal,
} from "lucide-react";
import { api, apiInWorkspace } from "./api";
import { executionSourceId } from "./sourceRouting";
import { SearchExcerpt } from "./SearchExcerpt";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { Chip } from "./ThreadTools";
import { relativeTime } from "./threadView";
import { Avatar, Badge, Empty, Sheet } from "./components";
import { belongsToProject } from "../shared/projects";
import type { Agent, Connection, Folder as Project } from "../shared/types";
import type { BriefPage } from "../shared/briefs";
import { ProjectBrief } from "./ProjectBrief";
import { BriefAcknowledgements } from "./briefView";

/** Ways into a project's history, alongside its Threads. */
export type ProjectHistory = "search" | "outcomes" | "saved" | "unfinished";
const historyRoutes: [Exclude<ProjectHistory, "search">, string, ReactNode][] =
  [
    ["outcomes", "Recent outcomes", <FileText size={16} key="o" />],
    ["saved", "Saved decisions", <Bookmark size={16} key="s" />],
    ["unfinished", "Unfinished work", <CircleDashed size={16} key="u" />],
  ];

type Summary = {
  id: string;
  name: string;
  agents: number;
  last_activity_at: number | null;
  working: number;
  needs: number;
  latest_result: { id: string; title: string; created_at: number } | null;
};

export function Projects({
  folders,
  agents,
  selected,
  onSelect,
  onCreate,
  onCreateAgent,
  onAgent,
  onAssign,
  renderFiles,
  renderActivity,
  renderThreads,
  renderHistory,
  onEdit,
  onNewTask,
  onWorkflows,
  onTeams,
  onReview,
  revision,
  connections = [],
  onBriefNavigate = (url) => location.assign(url),
}: {
  folders: Project[];
  agents: Agent[];
  selected: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCreateAgent: (id: string) => void;
  onAgent: (agent: Agent) => void;
  onAssign: (agent: Agent, id: string) => Promise<void>;
  renderFiles: (id: string) => ReactNode;
  renderActivity: (id: string) => ReactNode;
  renderThreads: (id: string) => ReactNode;
  renderHistory: (id: string, view: ProjectHistory, query: string) => ReactNode;
  onEdit: () => void;
  onNewTask: (id: string) => void;
  onWorkflows: () => void;
  onTeams: () => void;
  onReview?: (id: string) => void;
  revision: number;
  connections?: Connection[];
  onBriefNavigate?: (url: string) => void;
}) {
  const [adding, setAdding] = useState(false),
    [page, setPage] = useState(
      () => sessionStorage.getItem("loop-project-tab") || "threads",
    ),
    [summary, setSummary] = useState<Summary[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsId = useId();
  const current = folders.find((f) => f.id === selected);
  // Keep acknowledgement receipts across tab unmounts, scoped to the owner
  // workspace and project whose version was rendered.
  const briefAcks = useRef(new Map<string, BriefAcknowledgements>());
  const briefOwner = viewOwner(),
    workspace = executionSourceId();
  const ackKey = JSON.stringify([briefOwner, workspace, selected]);
  if (current?.kind === "project" && !briefAcks.current.has(ackKey))
    briefAcks.current.set(ackKey, new BriefAcknowledgements());
  const [brief, setBrief] = useState<BriefPage | null>(null),
    [briefScope, setBriefScope] = useState(""),
    [briefError, setBriefError] = useState(""),
    [briefLoad, setBriefLoad] = useState(0);
  const choseTab = useRef(false);
  const requestedTab = useRef(new URLSearchParams(location.search).get("projectTab"));
  const consumeRequestedTab = () => {
    requestedTab.current = null;
    const url = new URL(location.href);
    if (!url.searchParams.has("projectTab")) return;
    url.searchParams.delete("projectTab");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  };
  useEffect(() => {
    let active = true;
    choseTab.current = false;
    setToolsOpen(false);
    setBrief(null);
    setBriefScope(ackKey);
    setBriefError("");
    if (current?.kind !== "project") {
      if (page === "brief") setPage("threads");
      return;
    }
    const isCurrent = () =>
      active && briefOwner === viewOwner() && workspace === executionSourceId();
    void apiInWorkspace<BriefPage>(
      `/projects/${encodeURIComponent(selected)}/brief`,
      workspace,
    )
      .then((result) => {
        if (!isCurrent()) return;
        setBriefScope(ackKey);
        setBrief(result);
        if (!choseTab.current) {
          const remembered = sessionStorage.getItem(
            "loop-project-tab:" + selected,
          );
          const requested = requestedTab.current;
          consumeRequestedTab();
          if (requested === "brief" || requested === "threads")
            sessionStorage.setItem("loop-project-tab:" + selected, requested);
          setPage(
            (requested === "brief" || requested === "threads" ? requested : null) || remembered ||
              (result.settings.enabled
                ? "brief"
                : sessionStorage.getItem("loop-project-tab") === "brief"
                  ? "threads"
                  : sessionStorage.getItem("loop-project-tab") || "threads"),
          );
        }
      })
      .catch((error) => {
        if (isCurrent()) setBriefError(error.message);
      });
    return () => {
      active = false;
    };
  }, [selected, current?.kind, briefLoad, briefOwner, workspace]);
  // A history view replaces the tab content until you go back to Threads.
  // It is kept per project, so returning from a thread keeps it.
  const historyKey = "project-history:" + selected;
  const [history, setHistoryState] = useState<ProjectHistory | null>(
    () => cachedView<ProjectHistory>(historyKey) || null,
  );
  const [query, setQueryState] = useState(
    () => cachedView<string>(historyKey + ":q") || "",
  );
  const [submitted, setSubmitted] = useState(query);
  useEffect(() => {
    setHistoryState(cachedView<ProjectHistory>(historyKey) || null);
    const q = cachedView<string>(historyKey + ":q") || "";
    setQueryState(q);
    setSubmitted(q);
  }, [selected]);
  const setHistory = (value: ProjectHistory | null) => {
    setHistoryState(value);
    cacheView(historyKey, value, viewOwner());
  };
  const setQuery = (value: string) => {
    setQueryState(value);
    cacheView(historyKey + ":q", value, viewOwner());
  };
  const members = (id: string) =>
    agents.filter(
      (a) => !a.retired_at && belongsToProject(a.folder_id, id, folders),
    );
  const projectAgents = current ? members(current.id) : [];
  useEffect(() => {
    let active = true;
    api<{ items: Summary[] }>("/projects/summary")
      .then((result) => active && setSummary(result.items))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [revision, folders.length]);
  // Opening a project brings back anything snoozed "until I open this project".
  useEffect(() => {
    if (!selected) return;
    void api(`/projects/${selected}/opened`, {})
      .then((result: { surfaced?: number }) => {
        if (result?.surfaced)
          window.dispatchEvent(new Event("loop-later-change"));
      })
      .catch(() => {});
  }, [selected]);
  const projects = folders.filter((f) => f.kind === "project");
  const ordered = summary
    ? [
        ...summary
          .map((item) => ({
            item,
            folder: projects.find((f) => f.id === item.id),
          }))
          .filter((entry) => entry.folder),
        ...projects
          .filter((f) => !summary.some((item) => item.id === f.id))
          .map((folder) => ({ item: undefined, folder })),
      ]
    : projects.map((folder) => ({
        item: undefined as Summary | undefined,
        folder,
      }));
  const briefMode = current?.kind === "project" && page === "brief" && !history;
  return (
    <section
      className={"projects-view" + (briefMode ? " projects-brief-view" : "")}
    >
      {current ? (
        <>
          <div className="project-topbar">
            <button
              className={
                briefMode
                  ? "icon-button project-back"
                  : "text-button project-back"
              }
              aria-label="All projects"
              onClick={() => onSelect("")}
            >
              <ArrowLeft size={17} /> {!briefMode && "All projects"}
            </button>
            <div className="project-heading">
              <span className="project-symbol">
                <Folder size={26} />
              </span>
              <div>
                <h2>{current.name}</h2>
                <p>
                  {projectAgents.length}{" "}
                  {projectAgents.length === 1 ? "agent" : "agents"} in this
                  project
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Edit project"
                onClick={onEdit}
              >
                <Pencil size={18} />
              </button>
            </div>
            {briefMode && (
              <button
                type="button"
                className="icon-button"
                aria-label="Project tools"
                aria-expanded={toolsOpen}
                aria-controls={toolsId}
                onClick={() => setToolsOpen(!toolsOpen)}
              >
                <SlidersHorizontal size={18} />
              </button>
            )}
          </div>
          <div id={toolsId} hidden={briefMode && !toolsOpen}>
            <div className="project-actions">
              {onReview && (
                <button
                  className="secondary"
                  onClick={() => onReview(current.id)}
                >
                  Review changes
                </button>
              )}
              <button
                className="primary"
                disabled={!projectAgents.length}
                onClick={() => onNewTask(current.id)}
              >
                <MessageSquarePlus size={18} /> New task
              </button>
              <button
                className="secondary"
                onClick={() => onCreateAgent(current.id)}
              >
                <Plus size={18} /> New agent
              </button>
            </div>
            <form
              className="search-box project-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                (document.activeElement as HTMLElement | null)?.blur();
                if (!query.trim()) return;
                setSubmitted(query.trim());
                setHistory("search");
              }}
            >
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                enterKeyHint="search"
                aria-label={`Search ${current.name}`}
                placeholder={`Search ${current.name}`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!e.target.value.trim() && history === "search")
                    setHistory(null);
                }}
              />
            </form>
            <div
              className="chip-row project-history"
              aria-label="Project history"
            >
              {historyRoutes.map(([value, label, icon]) => (
                <button
                  key={value}
                  type="button"
                  className="chip"
                  aria-pressed={history === value}
                  onClick={() => setHistory(history === value ? null : value)}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="segmented project-tabs" aria-label="Project view">
            {[
              ...(current.kind === "project" ? ["brief"] : []),
              "threads",
              "agents",
              "activity",
              "files",
            ].map((value) => (
              <button
                key={value}
                className={!history && page === value ? "selected" : ""}
                aria-pressed={!history && page === value}
                onClick={() => {
                  setHistory(null);
                  setToolsOpen(false);
                  setPage(value);
                  choseTab.current = true;
                  consumeRequestedTab();
                  sessionStorage.setItem("loop-project-tab", value);
                  sessionStorage.setItem("loop-project-tab:" + selected, value);
                }}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          {history && (
            <div className="project-history-head">
              <h3>
                {history === "search"
                  ? `Results for “${submitted}” in ${current.name}`
                  : `${historyRoutes.find(([value]) => value === history)?.[1]} in ${current.name}`}
              </h3>
              <button
                type="button"
                className="text-button"
                onClick={() => setHistory(null)}
              >
                <ArrowLeft size={16} /> Back to{" "}
                {page[0].toUpperCase() + page.slice(1)}
              </button>
            </div>
          )}
          {history && renderHistory(current.id, history, submitted)}
          {!history &&
            page === "brief" &&
            (brief?.project === current.id && briefScope === ackKey ? (
              <ProjectBrief
                key={ackKey}
                projectId={current.id}
                initial={brief}
                acknowledgements={briefAcks.current.get(ackKey)!}
                connections={connections}
                agents={agents}
                onNavigate={onBriefNavigate}
                onChanged={setBrief}
              />
            ) : briefError && briefScope === ackKey ? (
              <div>
                <p className="error" role="alert">
                  {briefError}
                </p>
                <button
                  className="text-button"
                  onClick={() => setBriefLoad((value) => value + 1)}
                >
                  Try again
                </button>
              </div>
            ) : (
              <p className="muted">Loading brief…</p>
            ))}
          {!history && page === "threads" && renderThreads(current.id)}
          {!history && page === "activity" && renderActivity(current.id)}
          {!history && page === "files" && renderFiles(current.id)}
          {!history && page === "agents" && (
            <>
              {projectAgents.length ? (
                <div className="project-agents">
                  {projectAgents.map((a) => (
                    <button
                      className="project-agent"
                      key={a.id}
                      onClick={() => onAgent(a)}
                    >
                      <Avatar name={a.name} provider={a.provider} />
                      <span>
                        <strong>@{a.name}</strong>
                        <Badge provider={a.provider} />
                        <small>
                          {a.instructions || "Ready for your next task"}
                        </small>
                      </span>
                      <ArrowUpRight size={18} />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="project-empty">
                  No agents yet. Create one or add an existing agent to keep
                  this project’s work together.
                </p>
              )}
              <button
                className="text-button"
                onClick={() => {
                  setAdding(true);
                  setError("");
                }}
              >
                <UserPlus size={18} /> Add existing agent
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <div className="project-list-head">
            <button className="primary" onClick={onCreate}>
              <Plus size={18} /> New project
            </button>
          </div>
          {projects.length ? (
            <div className="project-grid">
              {ordered.map(({ item, folder }) => {
                const count = item?.agents ?? members(folder!.id).length;
                return (
                  <button
                    className="project-tile"
                    key={folder!.id}
                    onClick={() => onSelect(folder!.id)}
                  >
                    <Folder size={24} />
                    <strong>{folder!.name}</strong>
                    <span className="project-tile-meta">
                      {count} {count === 1 ? "agent" : "agents"}
                      {item?.last_activity_at
                        ? ` · active ${relativeTime(item.last_activity_at).toLowerCase()}`
                        : ""}
                    </span>
                    {item?.needs || item?.working ? (
                      <span className="project-tile-status">
                        {item?.needs ? (
                          <Chip tone="needs">{item.needs} need you</Chip>
                        ) : null}
                        {item?.working ? (
                          <Chip tone="working">{item.working} working</Chip>
                        ) : null}
                      </span>
                    ) : null}
                    {item?.latest_result && (
                      <span className="project-tile-latest">
                        Latest: {item.latest_result.title}
                      </span>
                    )}
                    <ArrowUpRight size={18} />
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty title="Give your next project a home.">
              Create a project, then add the agents you want working on it.
            </Empty>
          )}
          <h2 className="section-title">Across projects</h2>
          <div className="settings-links">
            <button onClick={onWorkflows}>
              <Workflow size={20} />
              <span>
                Workflows<small>Connect agents into an executable plan</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <button onClick={onTeams}>
              <Users size={20} />
              <span>
                Agent teams
                <small>A manager agent that delegates to workers</small>
              </span>
              <ArrowUpRight size={18} />
            </button>
          </div>
        </>
      )}
      {adding && current && (
        <Sheet
          title="Add an agent to this project"
          onClose={() => setAdding(false)}
        >
          <p className="muted">
            Choose an agent to move into {current.name}. Its existing
            conversations and files stay where they are.
          </p>
          <div className="project-agents">
            {agents
              .filter(
                (a) => !belongsToProject(a.folder_id, current.id, folders),
              )
              .map((a) => (
                <button
                  className="project-agent"
                  disabled={busy}
                  key={a.id}
                  onClick={async () => {
                    if (busy) return;
                    setBusy(true);
                    setError("");
                    try {
                      await onAssign(a, current.id);
                      setAdding(false);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Avatar name={a.name} provider={a.provider} />
                  <span>
                    <strong>@{a.name}</strong>
                    <small>{a.model}</small>
                    <small>
                      {folders.find((f) => f.id === a.folder_id)?.name ||
                        "Workspace"}
                    </small>
                  </span>
                  <Plus size={18} />
                </button>
              ))}
          </div>
          {!agents.some(
            (a) => !belongsToProject(a.folder_id, current.id, folders),
          ) && <p>All your agents are already in this project.</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </Sheet>
      )}
    </section>
  );
}

/** Search results inside one project, one card per thread. */
export function ProjectSearchResults({
  project,
  query,
  onConversation,
  onArtifact,
}: {
  project: string;
  query: string;
  onConversation: (conversation: string, message?: string) => void;
  onArtifact: (id: string) => void;
}) {
  const [result, setResult] = useState<{ items: any[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!query.trim()) return;
    let active = true;
    setResult(null);
    setError("");
    api<{ items: any[] }>(
      "/search?" + new URLSearchParams({ q: query, scope: "all", project }),
    )
      .then((r) => active && setResult(r))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [project, query]);
  const groups: { key: string; items: any[] }[] = [];
  for (const item of result?.items || []) {
    const key = item.conversation_id || item.id;
    const group = groups.find((g) => g.key === key);
    if (group) group.items.push(item);
    else groups.push({ key, items: [item] });
  }
  const open = (r: any) =>
    r.id.startsWith("message:")
      ? onConversation(r.conversation_id, r.id.slice(8))
      : onArtifact(r.id.slice(9));
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!result) return <p role="status">Searching…</p>;
  if (!groups.length)
    return (
      <Empty title="Nothing found in this project.">
        Try a shorter phrase.
      </Empty>
    );
  return (
    <div className="project-search-results">
      {groups.map(({ key, items }) => (
        <article className="search-result" key={key}>
          <div className="subline">
            <strong>@{items[0].name || "workspace"}</strong>
            <span>{relativeTime(items[0].created_at)}</span>
          </div>
          <h3>
            <button type="button" onClick={() => open(items[0])}>
              {items[0].title}
            </button>
          </h3>
          {items.slice(0, 3).map((r) => (
            <button
              type="button"
              key={r.id}
              className="search-hit"
              onClick={() => open(r)}
            >
              <small>{r.kind === "message" ? "Message" : "Result"}</small>
              <span className="search-snippet">
                <SearchExcerpt text={r.snippet} query={query} />
              </span>
            </button>
          ))}
        </article>
      ))}
    </div>
  );
}
