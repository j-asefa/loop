import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Folder,
  MessageSquarePlus,
  Plus,
  UserPlus,
  Pencil,
  Users,
  Workflow,
} from "lucide-react";
import { api } from "./api";
import { Chip } from "./ThreadTools";
import { relativeTime } from "./threadView";
import { Avatar, Badge, Empty, Sheet } from "./components";
import { belongsToProject } from "../shared/projects";
import type { Agent, Folder as Project } from "../shared/types";

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
  onEdit,
  onNewTask,
  onWorkflows,
  onTeams,
  revision,
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
  onEdit: () => void;
  onNewTask: (id: string) => void;
  onWorkflows: () => void;
  onTeams: () => void;
  revision: number;
}) {
  const [adding, setAdding] = useState(false),
    [page, setPage] = useState(
      () => sessionStorage.getItem("loop-project-tab") || "threads",
    ),
    [summary, setSummary] = useState<Summary[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = folders.find((f) => f.id === selected);
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
          .map((item) => ({ item, folder: projects.find((f) => f.id === item.id) }))
          .filter((entry) => entry.folder),
        ...projects
          .filter((f) => !summary.some((item) => item.id === f.id))
          .map((folder) => ({ item: undefined, folder })),
      ]
    : projects.map((folder) => ({ item: undefined as Summary | undefined, folder }));
  return (
    <section className="projects-view">
      {current ? (
        <>
          <button className="text-button" onClick={() => onSelect("")}>
            <ArrowLeft size={17} /> All projects
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
          <div className="project-actions">
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
          <div className="segmented project-tabs" aria-label="Project view">
            {["threads", "agents", "activity", "files"].map((value) => (
              <button
                key={value}
                className={page === value ? "selected" : ""}
                aria-pressed={page === value}
                onClick={() => {
                  setPage(value);
                  sessionStorage.setItem("loop-project-tab", value);
                }}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          {page === "threads" && renderThreads(current.id)}
          {page === "activity" && renderActivity(current.id)}
          {page === "files" && renderFiles(current.id)}
          {page === "agents" && (
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
                    {(item?.needs || item?.working) ? (
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
                Agent teams<small>A manager agent that delegates to workers</small>
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
