import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Folder,
  Plus,
  UserPlus,
  Pencil,
} from "lucide-react";
import { Avatar, Badge, Empty, Sheet } from "./components";
import { belongsToProject } from "../shared/projects";
import type { Agent, Folder as Project } from "../shared/types";

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
  onEdit,
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
  onEdit: () => void;
}) {
  const [adding, setAdding] = useState(false),
    [page, setPage] = useState(
      () => sessionStorage.getItem("loop-project-tab") || "agents",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = folders.find((f) => f.id === selected);
  const members = (id: string) =>
    agents.filter((a) => belongsToProject(a.folder_id, id, folders));
  const projectAgents = current ? members(current.id) : [];
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
              onClick={() => onCreateAgent(current.id)}
            >
              <Plus size={18} /> New agent
            </button>
            <button
              className="secondary"
              onClick={() => {
                setAdding(true);
                setError("");
              }}
            >
              <UserPlus size={18} /> Add existing agent
            </button>
          </div>
          <div className="segmented project-tabs" aria-label="Project view">
            {["agents", "activity", "files"].map((value) => (
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
            </>
          )}
        </>
      ) : (
        <>
          <div className="project-actions">
            <p className="muted">
              A place for each project and the agents working on it.
            </p>
            <button className="primary" onClick={onCreate}>
              <Plus size={18} /> New project
            </button>
          </div>
          {folders.some((f) => f.kind === "project") ? (
            <div className="project-grid">
              {folders
                .filter((f) => f.kind === "project")
                .map((f) => (
                  <button
                    className="project-tile"
                    key={f.id}
                    onClick={() => onSelect(f.id)}
                  >
                    <Folder size={24} />
                    <strong>{f.name}</strong>
                    <span>{members(f.id).length} agents</span>
                    <ArrowUpRight size={18} />
                  </button>
                ))}
            </div>
          ) : (
            <Empty title="Give your next project a home.">
              Create a project, then add the agents you want working on it.
            </Empty>
          )}
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
