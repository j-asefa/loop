import type { CardSelection } from "../shared/cards";
import type { EnvironmentAgent } from "./agentSources";

export type DoneReadFilter = NonNullable<CardSelection["read"]> | "all";
export const doneAgentKey = (agent: EnvironmentAgent, source: string) =>
  JSON.stringify([agent.sourceId ?? source, agent.id]);

export function DoneFeedFilters({
  read,
  agent,
  agents,
  source,
  onRead,
  onAgent,
  onClear,
}: {
  read: DoneReadFilter;
  agent: string;
  agents: EnvironmentAgent[];
  source: string;
  onRead: (value: DoneReadFilter) => void;
  onAgent: (value: string) => void;
  onClear: () => void;
}) {
  const multipleSources =
    new Set(agents.map((item) => item.sourceId ?? source)).size > 1;
  return (
    <div className="done-feed-filters" role="group" aria-label="Filter Done">
      <div className="done-read-filters" role="group" aria-label="Read status">
        {(["all", "unread", "read"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={read === value}
            onClick={() => onRead(value)}
          >
            {value === "all" ? "All" : value === "unread" ? "Unread" : "Read"}
          </button>
        ))}
      </div>
      <label className="scope-chip done-agent-filter">
        <span className="sr-only">Agent</span>
        <select
          aria-label="Filter Done by agent"
          value={agent}
          onChange={(event) => onAgent(event.target.value)}
        >
          <option value="">All agents</option>
          {[...agents]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((item) => (
              <option
                key={doneAgentKey(item, source)}
                value={doneAgentKey(item, source)}
              >
                @{item.name}
                {multipleSources && item.executionEnvironment
                  ? ` · ${item.executionEnvironment}`
                  : ""}
              </option>
            ))}
        </select>
      </label>
      {(read !== "all" || agent) && (
        <button type="button" className="text-button" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
