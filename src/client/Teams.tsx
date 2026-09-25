import { useRef, useState } from "react";
import { api } from "./api";
import { Sheet } from "./components";
import { Check, ChevronDown, Search, Users } from "lucide-react";
import type { Agent, Team } from "../shared/types";
export function TeamFilter({
  teams,
  selected,
  onChange,
  onCreate,
  onOpen,
}: {
  teams: Team[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onCreate: () => void;
  onOpen: (team: Team) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    requestAnimationFrame(() =>
      trigger.current?.focus({ preventScroll: true }),
    );
  }
  const chosen = teams.filter((t) => selected.includes(t.id));
  const summary =
    chosen.length === 1
      ? chosen[0].name
      : chosen.length
        ? `${chosen.length} teams`
        : "All teams";
  return (
    <div className="team-toolbar">
      <button
        ref={trigger}
        className="team-filter"
        aria-label={`Filter by team: ${summary}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        <Users size={18} />
        <span>{summary}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <Sheet title="Filter by team" onClose={close}>
          <p className="muted">
            Choose the teams you want to see in your feed.
          </p>
          <label className="team-search">
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="Search teams"
              type="search"
              placeholder="Find a team…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="team-options">
            <button
              className="team-option"
              aria-pressed={!selected.length}
              onClick={() => onChange([])}
            >
              <Users size={20} />
              <span>
                <strong>All teams</strong>
                <small>Every team and your individual agents</small>
              </span>
              {!selected.length && <Check size={20} />}
            </button>
            {teams
              .filter((t) =>
                t.name.toLowerCase().includes(query.toLowerCase().trim()),
              )
              .map((t) => (
                <label className="team-option" key={t.id}>
                  <input
                    type="checkbox"
                    aria-label={t.name}
                    checked={selected.includes(t.id)}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...selected, t.id]
                          : selected.filter((id) => id !== t.id),
                      )
                    }
                  />
                  <span>
                    <strong>{t.name}</strong>
                    <small>
                      {t.members.length + 1} agents · manager and workers
                    </small>
                  </span>
                </label>
              ))}
            {!teams.length && (
              <p className="muted">Create a team to give it its own feed.</p>
            )}
            {teams.length > 0 &&
              !teams.some((t) =>
                t.name.toLowerCase().includes(query.toLowerCase().trim()),
              ) && (
                <p className="muted" role="status">
                  No teams match “{query}”.
                </p>
              )}
          </div>
          <div className="team-picker-actions">
            <span className="muted">
              {chosen.length
                ? `${chosen.length} selected`
                : "Showing all activity"}
            </span>
            <button className="primary" onClick={close}>
              Done
            </button>
          </div>
        </Sheet>
      )}
      {selected.length === 1 && (
        <button
          className="text-button"
          onClick={() => onOpen(teams.find((t) => t.id === selected[0])!)}
        >
          Message manager
        </button>
      )}
      <button className="text-button" onClick={onCreate}>
        New team
      </button>
    </div>
  );
}
export function CreateTeam({
  agents,
  onClose,
  onCreated,
  onCreateAgent,
}: {
  agents: Agent[];
  onClose: () => void;
  onCreated: (t: Team) => void;
  onCreateAgent: () => void;
}) {
  const available = agents.filter((a) => a.connection_id);
  const [name, setName] = useState(""),
    [manager, setManager] = useState(available[0]?.id || ""),
    [members, setMembers] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Sheet title="Create an agent team" onClose={onClose}>
      <p>
        Talk to the manager. It delegates tasks to workers, whose updates appear
        in this team's feed and in All teams.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            onCreated(
              await api("/teams", { name, managerId: manager, members }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Team name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Manager
          <select
            aria-label="Manager"
            value={manager}
            onChange={(e) => {
              setManager(e.target.value);
              setMembers((v) => v.filter((id) => id !== e.target.value));
            }}
          >
            <option value="">Choose a manager</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Workers</legend>
          {available
            .filter((a) => a.id !== manager)
            .map((a) => (
              <label className="checkbox-row" key={a.id}>
                <input
                  type="checkbox"
                  checked={members.includes(a.id)}
                  onChange={(e) =>
                    setMembers(
                      e.target.checked
                        ? [...members, a.id]
                        : members.filter((id) => id !== a.id),
                    )
                  }
                />
                @{a.name}
              </label>
            ))}
        </fieldset>
        <button type="button" className="text-button" onClick={onCreateAgent}>
          Create another agent
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={busy || !manager || !members.length || members.length > 8}
        >
          {busy ? "Creating…" : "Create team & talk to manager"}
        </button>
      </form>
    </Sheet>
  );
}
