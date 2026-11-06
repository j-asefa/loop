import { type ReactNode, useState } from "react";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { Avatar, Sheet } from "./components";
import type { Team } from "../shared/types";
import type { EnvironmentAgent } from "./agentSources";
import { literalEntry } from "./textEntry";

export const workspaceAgentKey = (agent: EnvironmentAgent, source: string) =>
  JSON.stringify([agent.sourceId ?? source, agent.id]);

export const workspaceAgentInTeams = (
  item: EnvironmentAgent,
  ids: string[],
  teams: Team[],
  source: string,
) =>
  !ids.length ||
  ((item.sourceId ?? source) === source &&
    teams.some(
      (team) =>
        ids.includes(team.id) &&
        [team.manager_id, ...team.members].includes(item.id),
    ));

export function compatibleWorkspaceAgent(
  value: string,
  ids: string[],
  agents: EnvironmentAgent[],
  teams: Team[],
  source: string,
) {
  if (!ids.length) return value;
  const current = agents.find(
    (item) => workspaceAgentKey(item, source) === value,
  );
  return current && workspaceAgentInTeams(current, ids, teams, source)
    ? value
    : "";
}

export function WorkspaceFilters({
  workspace,
  teams,
  selectedTeams,
  agents,
  agent,
  source,
  onChange,
  management,
}: {
  workspace: string;
  teams: Team[];
  selectedTeams: string[];
  agents: EnvironmentAgent[];
  agent: string;
  source: string;
  onChange: (teams: string[], agent: string) => void;
  management: (closeFilters: () => void) => ReactNode;
}) {
  const [draft, setDraft] = useState<{ teams: string[]; agent: string } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const chosen = teams.filter((team) => selectedTeams.includes(team.id));
  const selectedAgent = agents.find(
    (item) => workspaceAgentKey(item, source) === agent,
  );
  const count = selectedTeams.length + (agent ? 1 : 0);
  const inTeams = (item: EnvironmentAgent, ids: string[]) =>
    workspaceAgentInTeams(item, ids, teams, source);
  const compatibleAgent = (value: string, ids: string[]) =>
    compatibleWorkspaceAgent(value, ids, agents, teams, source);
  const options = agents.filter(
    (item) =>
      inTeams(item, draft?.teams || []) &&
      `@${item.name} ${item.executionEnvironment || ""}`
        .toLocaleLowerCase()
        .includes(query.trim().replace(/^@/, "").toLocaleLowerCase()),
  );
  const multipleSources =
    new Set(agents.map((item) => item.sourceId ?? source)).size > 1;
  return (
    <div
      className="workspace-filters"
      role="group"
      aria-label="Workspace filters"
    >
      <button
        type="button"
        className="workspace-filter-trigger"
        aria-haspopup="dialog"
        aria-expanded={!!draft}
        onClick={() => {
          setQuery("");
          setDraft({ teams: selectedTeams, agent });
        }}
      >
        <SlidersHorizontal size={17} /> Filters{count ? ` · ${count}` : ""}
      </button>
      {selectedTeams.map((id) => (
        <button
          type="button"
          className="workspace-filter-chip"
          key={id}
          aria-label={`Remove team filter: ${chosen.find((team) => team.id === id)?.name || "Unavailable team"}`}
          onClick={() => {
            const ids = selectedTeams.filter((value) => value !== id);
            onChange(ids, compatibleAgent(agent, ids));
          }}
        >
          {chosen.find((team) => team.id === id)?.name || "Unavailable team"}{" "}
          <X size={14} />
        </button>
      ))}
      {agent && (
        <button
          type="button"
          className="workspace-filter-chip"
          onClick={() => onChange(selectedTeams, "")}
          aria-label="Remove agent filter"
        >
          {selectedAgent ? `@${selectedAgent.name}` : "Unavailable agent"}{" "}
          <X size={14} />
        </button>
      )}
      {!count && <span className="muted">Everyone</span>}
      {draft && (
        <Sheet
          title="Filter workspace"
          className="workspace-filter-sheet"
          onClose={() => setDraft(null)}
        >
          <p className="muted">Within {workspace}</p>
          <fieldset>
            <legend>Team</legend>
            <button
              type="button"
              aria-pressed={!draft.teams.length}
              onClick={() => setDraft({ ...draft, teams: [] })}
            >
              Everyone {!draft.teams.length && <Check size={18} />}
            </button>
            {teams.map((team) => (
              <button
                type="button"
                key={team.id}
                aria-pressed={draft.teams.includes(team.id)}
                onClick={() => {
                  const ids = draft.teams.includes(team.id)
                    ? draft.teams.filter((id) => id !== team.id)
                    : [...draft.teams, team.id];
                  setDraft({
                    teams: ids,
                    agent: compatibleAgent(draft.agent, ids),
                  });
                }}
              >
                {team.name}
                {draft.teams.includes(team.id) && <Check size={18} />}
              </button>
            ))}
            {management(() => setDraft(null))}
          </fieldset>
          <fieldset>
            <legend>Agent</legend>
            <label className="directory-search">
              <Search size={18} />
              <input
                {...literalEntry}
                type="search"
                aria-label="Search agents"
                placeholder="Search agents…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              aria-pressed={!draft.agent}
              onClick={() => setDraft({ ...draft, agent: "" })}
            >
              All agents {!draft.agent && <Check size={18} />}
            </button>
            {options.map((item) => {
              const key = workspaceAgentKey(item, source);
              return (
                <button
                  type="button"
                  key={key}
                  aria-label={`@${item.name}${multipleSources ? ` · ${item.executionEnvironment || "This computer"}` : ""}`}
                  aria-pressed={draft.agent === key}
                  onClick={() => setDraft({ ...draft, agent: key })}
                >
                  <Avatar name={item.name} provider={item.provider} />
                  <span>
                    @{item.name}
                    {item.retired_at ? " (retired)" : ""}
                    {multipleSources
                      ? ` · ${item.executionEnvironment || "This computer"}`
                      : ""}
                  </span>
                  {draft.agent === key && <Check size={18} />}
                </button>
              );
            })}
            {!options.length && (
              <p className="note" role="status">
                No agents match these filters.
              </p>
            )}
          </fieldset>
          <footer className="workspace-filter-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => setDraft({ teams: [], agent: "" })}
            >
              Clear all
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const ids = draft.teams.filter((id) =>
                  teams.some((team) => team.id === id),
                );
                onChange(ids, compatibleAgent(draft.agent, ids));
                setDraft(null);
              }}
            >
              Apply filters
            </button>
          </footer>
        </Sheet>
      )}
    </div>
  );
}
