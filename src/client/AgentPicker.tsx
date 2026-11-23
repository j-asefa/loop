import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { Sheet } from "./components";
import { literalEntry } from "./textEntry";

/** Orders agents by name, ignoring case and accents, so every picker agrees. */
export function compareAgentNames(
  a: { id: string; name: string },
  b: { id: string; name: string },
) {
  return (
    a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    }) || a.id.localeCompare(b.id)
  );
}

export const sortAgentsByName = <T extends { id: string; name: string }>(
  agents: readonly T[],
) => [...agents].sort(compareAgentNames);

const searchText = (value: string) =>
  value.trim().replace(/^@/, "").toLocaleLowerCase();

/** True when the agent's name or detail contains the typed search. */
export const agentMatches = (
  query: string,
  agent: { name: string; detail?: string },
) => {
  const search = searchText(query);
  return (
    !search ||
    `${agent.name} ${agent.detail || ""}`.toLocaleLowerCase().includes(search)
  );
};

export type AgentChoice = {
  /** The value passed to onChange. */
  value: string;
  name: string;
  /** Shown after the name and searched with it, such as a model. */
  detail?: string;
};

export type PickerExtra = {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
};

/**
 * A button that opens a searchable, alphabetical list of agents. Extras such
 * as "Any agent" stay above the agents and are never filtered out.
 */
export function AgentPicker({
  label,
  title = label,
  agents,
  value,
  onChange,
  extras = [],
  placeholder = "Choose an agent",
  disabled = false,
  className = "agent-picker",
}: {
  label: string;
  title?: string;
  agents: readonly AgentChoice[];
  value: string;
  onChange: (value: string) => void;
  extras?: readonly PickerExtra[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const valueId = useId();
  const text = (agent: AgentChoice) =>
    `@${agent.name}${agent.detail ? ` · ${agent.detail}` : ""}`;
  const current = agents.find((agent) => agent.value === value);
  const currentExtra = extras.find((extra) => extra.value === value);
  const shown = current
    ? text(current)
    : currentExtra
      ? currentExtra.label
      : placeholder;
  const matches = [...agents]
    .filter((agent) => agentMatches(query, agent))
    .sort((a, b) =>
      compareAgentNames(
        { id: a.value, name: a.name },
        { id: b.value, name: b.name },
      ),
    );
  const choose = (next: string) => {
    setOpen(false);
    // The trigger was disabled while the sheet was open, as by a send.
    if (disabled) return;
    if (next !== value) onChange(next);
  };
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-describedby={valueId}
        aria-haspopup="dialog"
        aria-expanded={open}
        value={value}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        {currentExtra?.icon}
        <span id={valueId}>{shown}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open &&
        // Callers often wrap the picker in a <label>; keeping the sheet out of
        // it stops clicks on the sheet from re-activating the trigger.
        createPortal(
          <Sheet
            title={title}
            className="agent-picker-sheet"
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
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  // Only a typed search picks its first match; Enter on an
                  // empty search keeps choices such as "Let Loop choose".
                  if (query.trim() && matches.length) choose(matches[0].value);
                }}
                autoFocus
              />
            </label>
            <div
              className="agent-picker-options"
              role="group"
              aria-label="Agents"
            >
              {extras.map((extra) => (
                <button
                  key={`extra:${extra.value}`}
                  type="button"
                  value={extra.value}
                  aria-pressed={value === extra.value}
                  disabled={extra.disabled}
                  onClick={() => choose(extra.value)}
                >
                  <span>
                    {extra.icon}
                    {extra.label}
                  </span>
                  {value === extra.value && (
                    <Check size={18} aria-hidden="true" />
                  )}
                </button>
              ))}
              {matches.map((agent) => (
                <button
                  key={agent.value}
                  type="button"
                  value={agent.value}
                  aria-pressed={value === agent.value}
                  onClick={() => choose(agent.value)}
                >
                  <span>{text(agent)}</span>
                  {value === agent.value && (
                    <Check size={18} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
            {!matches.length && (
              <p className="note" role="status">
                {agents.length
                  ? "No agents match your search."
                  : "No agents to choose from."}
              </p>
            )}
          </Sheet>,
          document.body,
        )}
    </>
  );
}

/** A search field that filters an inline list of agents, such as checkboxes. */
export function AgentSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="directory-search">
      <Search size={18} aria-hidden="true" />
      <input
        {...literalEntry}
        type="search"
        aria-label="Search agents"
        placeholder="Search agents…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Filtering never submits a surrounding form, such as Create team.
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
    </label>
  );
}
