import { useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { CardSelection } from "../shared/cards";
import type { EnvironmentAgent } from "./agentSources";
import { Sheet } from "./components";
import { literalEntry } from "./textEntry";

export type DoneReadFilter = NonNullable<CardSelection["read"]> | "all";
export const doneAgentKey = (agent: EnvironmentAgent, source: string) =>
  JSON.stringify([agent.sourceId ?? source, agent.id]);

export function DoneFeedFilters({
  hideAgent = false,
  read,
  agent,
  agents,
  source,
  onRead,
  onAgent,
  onClear,
}: {
  hideAgent?: boolean;
  read: DoneReadFilter;
  agent: string;
  agents: EnvironmentAgent[];
  source: string;
  onRead: (value: DoneReadFilter) => void;
  onAgent: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const multipleSources =
    new Set(agents.map((item) => item.sourceId ?? source)).size > 1;
  const label = (item: EnvironmentAgent) =>
    `@${item.name}${multipleSources && item.executionEnvironment ? ` · ${item.executionEnvironment}` : ""}`;
  const selected = agents.find((item) => doneAgentKey(item, source) === agent);
  const search = query.trim().replace(/^@/, "").toLocaleLowerCase();
  const matches = [...agents]
    .filter((item) => label(item).toLocaleLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name));
  const choose = (value: string) => {
    onAgent(value);
    setOpen(false);
  };
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
      {!hideAgent && (
        <button
          type="button"
          className="done-agent-filter"
          aria-label="Filter Done by agent"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
        >
          <span>{selected ? label(selected) : "All agents"}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      )}
      {open && (
        <Sheet
          title="Filter Done by agent"
          className="done-agent-picker"
          onClose={() => setOpen(false)}
        >
          <label className="directory-search">
            <Search size={18} aria-hidden="true" />
            <input
              {...literalEntry}
              type="search"
              aria-label="Search agents"
              placeholder="Search agents…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </label>
          <div className="done-agent-options" role="group" aria-label="Agents">
            <button
              type="button"
              aria-pressed={!agent}
              onClick={() => choose("")}
            >
              <span>All agents</span>
              {!agent && <Check size={18} aria-hidden="true" />}
            </button>
            {matches.map((item) => {
              const key = doneAgentKey(item, source);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={agent === key}
                  onClick={() => choose(key)}
                >
                  <span>{label(item)}</span>
                  {agent === key && <Check size={18} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {!matches.length && (
            <p className="note" role="status">
              No agents match your search.
            </p>
          )}
        </Sheet>
      )}
      {(read !== "all" || agent) && (
        <button type="button" className="text-button" onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}
