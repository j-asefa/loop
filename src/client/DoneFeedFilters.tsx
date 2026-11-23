import type { CardSelection } from "../shared/cards";
import type { EnvironmentAgent } from "./agentSources";
import { AgentPicker } from "./AgentPicker";

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
      <AgentPicker
        label="Filter Done by agent"
        className="done-agent-filter"
        value={agent}
        onChange={onAgent}
        extras={[{ value: "", label: "All agents" }]}
        agents={agents.map((item) => ({
          value: doneAgentKey(item, source),
          name: item.name,
          detail: multipleSources ? item.executionEnvironment : undefined,
        }))}
      />
      {(read !== "all" || agent) && (
        <button type="button" className="text-button" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
