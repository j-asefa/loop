import { useState } from "react";
import { ArrowUpRight, Plus, Search } from "lucide-react";
import { Avatar, Badge, Empty, Sheet } from "./components";
import type { EnvironmentAgent, EnvironmentFolder } from "./agentSources";

export function AgentDirectory({
  agents,
  scopedKeys,
  folders,
  onAgent,
  onCreate,
  onClose,
}: {
  agents: EnvironmentAgent[];
  scopedKeys: string[];
  folders: EnvironmentFolder[];
  onAgent: (agent: EnvironmentAgent) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [retired, setRetired] = useState(false);
  const key = (agent: EnvironmentAgent) => `${agent.sourceId || "laptop"}:${agent.id}`;
  const filtered = agents.filter(
    (a) =>
      !!a.retired_at === retired &&
      (retired || all || scopedKeys.includes(key(a))) &&
      `${a.name} ${a.model} ${a.instructions}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <Sheet title="Your agents" onClose={onClose}>
      <div className="segmented">
        <button
          className={!retired ? "selected" : ""}
          aria-pressed={!retired}
          onClick={() => setRetired(false)}
        >
          Active agents
        </button>
        <button
          className={retired ? "selected" : ""}
          aria-pressed={retired}
          onClick={() => setRetired(true)}
        >
          Retired agents
        </button>
      </div>
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
      {!retired &&
        scopedKeys.length !== agents.filter((a) => !a.retired_at).length && (
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
            key={key(a)}
            onClick={() => onAgent(a)}
          >
            <Avatar name={a.name} provider={a.provider} />
            <span>
              <strong>@{a.name}</strong>
              <Badge provider={a.provider} />
              <small>
                {a.model} · {a.executionEnvironment || "This laptop"}
                {a.folder_id && folders.find((f) =>
                  f.id === a.folder_id && (f.sourceId || "") === (a.sourceId || "")) &&
                  ` · ${folders.find((f) =>
                    f.id === a.folder_id && (f.sourceId || "") === (a.sourceId || ""))?.name}`}
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
              : !all && !scopedKeys.length
                ? "No agents in this view."
                : "No matching agents."
          }
        >
          {!agents.length
            ? "Create your first agent to get started."
            : !all && !scopedKeys.length
              ? "Show all workspace agents or create an agent here."
              : "Try a different name" +
                (!all && scopedKeys.length !== agents.length
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
