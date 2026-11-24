import type { CardSelection } from "../shared/cards";
import type { FeedSourceFilter } from "../shared/feed-interleave";
import type { EnvironmentAgent } from "./agentSources";
import { AgentPicker } from "./AgentPicker";

export type DoneReadFilter = NonNullable<CardSelection["read"]> | "all";
export const doneAgentKey = (agent: EnvironmentAgent, source: string) =>
  JSON.stringify([agent.sourceId ?? source, agent.id]);

const streamSources: readonly { id: FeedSourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "feeds", label: "Feeds" },
];

export function DoneFeedFilters({
  read,
  agent,
  agents,
  source,
  streamSource,
  onStreamSource,
  onRead,
  onAgent,
  onClear,
}: {
  read: DoneReadFilter;
  agent: string;
  agents: EnvironmentAgent[];
  source: string;
  streamSource?: FeedSourceFilter;
  onStreamSource?: (value: FeedSourceFilter) => void;
  onRead: (value: DoneReadFilter) => void;
  onAgent: (value: string) => void;
  onClear: () => void;
}) {
  const multipleSources =
    new Set(agents.map((item) => item.sourceId ?? source)).size > 1;
  const activeStream = streamSource ?? "all";
  const hasFilters =
    read !== "all" || !!agent || (!!onStreamSource && activeStream !== "all");
  return (
    <div className="done-feed-filters" role="group" aria-label="Filter Done">
      {onStreamSource && (
        <div
          className="done-read-filters stream-source-filters"
          role="group"
          aria-label="Feed source"
        >
          {streamSources.map((option) => (
            <button
              key={option.id}
              type="button"
              className="chip"
              aria-pressed={activeStream === option.id}
              onClick={() => onStreamSource(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
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
      {activeStream !== "feeds" && (
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
      )}
      {hasFilters && (
        <button type="button" className="text-button" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
