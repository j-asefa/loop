import { useState } from "react";
import { ArrowUpRight, Plus, Search } from "lucide-react";
import { Avatar, Badge, Empty, Sheet } from "./components";
import type { Agent, Folder } from "../shared/types";

export function AgentDirectory({
  agents,
  scopedIds,
  folders,
  onAgent,
  onCreate,
  onClose,
}: {
  agents: Agent[];
  scopedIds: string[];
  folders: Folder[];
  onAgent: (agent: Agent) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const filtered = agents.filter(
    (a) =>
      (all || scopedIds.includes(a.id)) &&
      `${a.name} ${a.model} ${a.instructions}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <Sheet title="Your agents" onClose={onClose}>
      <label className="directory-search">
        <Search size={18} />
        <input
          autoFocus
          type="search"
          aria-label="Search agents"
          placeholder="Find an agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {scopedIds.length !== agents.length && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />{" "}
          Show all workspace agents
        </label>
      )}
      <div className="project-agents">
        {filtered.map((a) => (
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
                {a.model} ·{" "}
                {folders.find((f) => f.id === a.folder_id)?.name || "Workspace"}
              </small>
            </span>
            <ArrowUpRight size={18} />
          </button>
        ))}
      </div>
      {!filtered.length && (
        <Empty
          title={
            !agents.length
              ? "No agents yet."
              : !all && !scopedIds.length
                ? "No agents in this view."
                : "No matching agents."
          }
        >
          {!agents.length
            ? "Create your first agent to get started."
            : !all && !scopedIds.length
              ? "Show all workspace agents or create an agent here."
              : "Try a different name" +
                (!all && scopedIds.length !== agents.length
                  ? " or show all workspace agents."
                  : ".")}
        </Empty>
      )}
      <button className="primary sheet-submit" onClick={onCreate}>
        <Plus size={18} /> New agent
      </button>
    </Sheet>
  );
}
