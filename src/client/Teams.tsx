import { useRef, useState } from "react";
import { api } from "./api";
import { Avatar, Sheet } from "./components";
import {
  Check,
  ChevronDown,
  Search,
  Users,
  Trash2,
  MessageSquare,
  ArrowUpRight,
} from "lucide-react";
import type { Agent, Team } from "../shared/types";

export function TeamManagerShortcut({
  teams,
  agents,
  selected,
  onOpen,
}: {
  teams: Team[];
  agents: Agent[];
  selected: string[];
  onOpen: (team: Team) => void;
}) {
  const [open, setOpen] = useState(false);
  const choices = teams.filter((team) => selected.includes(team.id));
  if (!choices.length) return null;
  const manager =
    choices.length === 1
      ? agents.find((agent) => agent.id === choices[0].manager_id)
      : undefined;
  return (
    <div className="team-manager-shortcut">
      <button
        className="text-button"
        onClick={() => {
          if (choices.length === 1) onOpen(choices[0]);
          else setOpen(true);
        }}
        aria-label="Message manager"
      >
        <MessageSquare size={17} aria-hidden="true" />
        Message manager
        {manager && <span className="muted">@{manager.name}</span>}
      </button>
      {open && (
        <Sheet title="Message a team manager" onClose={() => setOpen(false)}>
          <div className="team-manager-options">
            {choices.map((team) => {
              const manager = agents.find(
                (agent) => agent.id === team.manager_id,
              );
              return (
                <button
                  className="team-manager-option"
                  key={team.id}
                  aria-label={`Message manager of ${team.name}`}
                  onClick={() => {
                    setOpen(false);
                    onOpen(team);
                  }}
                >
                  <Avatar name={manager?.name} provider={manager?.provider} />
                  <span>
                    <strong>{team.name}</strong>
                    <small>
                      {manager ? `@${manager.name}` : "Team manager"}
                    </small>
                  </span>
                  <ArrowUpRight size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ProfileTeams({
  agent,
  teams,
  onMessage,
  onOpen,
}: {
  agent: Agent;
  teams: Team[];
  onMessage: (team: Team) => void;
  onOpen: (team: Team) => void;
}) {
  const memberships = teams.filter(
    (team) => team.manager_id === agent.id || team.members.includes(agent.id),
  );
  if (!memberships.length) return null;
  return (
    <div className="profile-teams" role="group" aria-label="Agent teams">
      <span className="eyebrow">
        {memberships.length === 1 ? "Team" : "Teams"}
      </span>
      {memberships.map((team) => (
        <div className="profile-team" key={team.id}>
          <a
            className="profile-team-link"
            href={`/?teams=${encodeURIComponent(team.id)}`}
            aria-label={`Open team ${team.name}`}
            onClick={(event) => {
              if (
                event.button ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onOpen(team);
            }}
          >
            <span>
              <strong>{team.name}</strong>
              <small>
                {team.manager_id === agent.id ? "Manager" : "Member"}
              </small>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <button
            className="text-button"
            aria-label={`Message manager of ${team.name}`}
            onClick={() => onMessage(team)}
          >
            <MessageSquare size={16} aria-hidden="true" /> Message manager
          </button>
        </div>
      ))}
    </div>
  );
}

export function TeamFilter({
  teams,
  selected,
  onChange,
  onCreate,
  onOpen,
  onDeleted,
}: {
  teams: Team[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onCreate: () => void;
  onOpen: (team: Team) => void;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Team | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
      {open && !deleting && (
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
          {chosen.length === 1 && (
            <div className="actions">
              <button
                className="text-button"
                onClick={() => {
                  close();
                  onOpen(chosen[0]);
                }}
              >
                Message manager
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  setDeleting(chosen[0]);
                }}
              >
                <Trash2 size={17} /> Delete team
              </button>
            </div>
          )}
          <button
            className="text-button"
            onClick={() => {
              close();
              onCreate();
            }}
          >
            New team
          </button>

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
      {deleting && (
        <Sheet
          title={`Delete ${deleting.name}?`}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p>
            This removes the team from your workspace. Its agents, files, and
            conversations stay available. Work already in progress can finish.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Keep team
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  await api(
                    `/teams/${deleting.id}`,
                    undefined,
                    "DELETE",
                    AbortSignal.timeout(15000),
                  );
                  onDeleted(deleting.id);
                  setDeleting(null);
                  close();
                } catch (error) {
                  setError(
                    (error as Error).name === "TimeoutError"
                      ? "Loop took too long to respond. Try deleting again; your agents and history stay safe."
                      : (error as Error).message,
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting…" : "Delete team"}
            </button>
          </div>
        </Sheet>
      )}
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
  const available = agents.filter((a) => a.connection_id && !a.retired_at);
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
