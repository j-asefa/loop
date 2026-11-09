import { MAX_TEAM_WORKERS } from "../shared/team-limits";
import { literalEntry, proseEntry } from "./textEntry";
import { useRef, useState } from "react";
import { callRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import { Avatar, Sheet } from "./components";
import {
  Check,
  ChevronDown,
  Search,
  Users,
  Trash2,
  MessageSquare,
  ArrowUpRight,
  Mail,
  UserPlus,
  EyeOff,
  Plus,
} from "lucide-react";
import { PresetPicker, PresetTeamForm } from "./TeamPresets";
import { agentModelName } from "./modelChoices";
import { TEAM_PRESETS, type TeamPreset } from "../shared/team-presets";
import type { Agent, Connection, Team, Folder } from "../shared/types";
import { AgentMailThreads } from "./AgentMail";
import { SettingsToggle } from "./SettingsUI";
import { viewOwner } from "./viewCache";
import { executionSourceId } from "./sourceRouting";
import {
  CreateFromDefinition,
  MarkdownDefinitions,
} from "./MarkdownDefinitions";
import type { AgentDefinition } from "../shared/agent-definitions";

function TeamFeedVisibility({
  team,
  onChanged,
}: {
  team: Team;
  onChanged: (team: Team) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <SettingsToggle
        title="Show in All teams"
        description="When off, this team's Done and Threads cards only appear when you select it. Needs you, Working and Queued always show."
        checked={!team.hide_results_from_feed}
        disabled={busy}
        onChange={async (show) => {
          if (busy) return;
          const owner = viewOwner(),
            source = executionSourceId();
          setBusy(true);
          setError("");
          try {
            const updated = await callRoute(
              workspaceApi.teamFeedVisibility,
              { params: { id: team.id }, body: { hideResultsFromFeed: !show } },
              source,
              AbortSignal.timeout(15000),
            );
            if (owner === viewOwner() && source === executionSourceId())
              onChanged(updated);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TeamDirectory({
  teams,
  agents,
  connections,
  folders = [],
  onClose,
  onOpen,
  onCreate,
  onChanged,
  onVisibilityChanged,
  onReview,
}: {
  teams: Team[];
  agents: Agent[];
  connections: Connection[];
  folders?: Folder[];
  onClose: () => void;
  onOpen: (team: Team) => void;
  onCreate: () => void;
  onChanged: () => void;
  onVisibilityChanged: (team: Team) => void;
  onReview?: (team: Team) => void;
}) {
  const [adding, setAdding] = useState<Team | null>(null);
  const [definitionsOpen, setDefinitionsOpen] = useState(false);
  const [definition, setDefinition] = useState<AgentDefinition>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = (id: string) =>
    agents.find((agent) => agent.id === id)?.name || "Former agent";
  const available = adding
    ? agents.filter(
        (agent) =>
          !agent.retired_at &&
          connections.some(
            (connection) =>
              connection.id === agent.connection_id &&
              connection.status === "connected",
          ) &&
          agent.id !== adding.manager_id &&
          !adding.members.includes(agent.id),
      )
    : [];
  const backToTeams = () => {
    setAdding(null);
    setError("");
  };
  if (adding && definitionsOpen)
    return (
      <MarkdownDefinitions
        key={executionSourceId()}
        kind="agent"
        sourceId={executionSourceId()}
        onClose={() => setDefinitionsOpen(false)}
        onUse={(item) => {
          setDefinition(item);
          setDefinitionsOpen(false);
        }}
      />
    );
  if (adding && definition)
    return (
      <CreateFromDefinition
        key={`${executionSourceId()}:${definition.id}:${definition.version}`}
        definition={definition}
        sourceId={executionSourceId()}
        connections={connections}
        folders={folders}
        initialFolder={adding.folder_id || undefined}
        teamId={adding.id}
        onClose={() => setDefinition(undefined)}
        onCreated={() => {
          setDefinition(undefined);
          setAdding(null);
          onChanged();
        }}
      />
    );
  return (
    <Sheet
      title={adding ? `Add a worker to ${adding.name}` : "Agent teams"}
      onClose={adding ? backToTeams : onClose}
    >
      {adding ? (
        <>
          <p className="muted">
            Choose an agent with a connected provider. A team can have up to{" "}
            {MAX_TEAM_WORKERS} workers.
          </p>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => setDefinitionsOpen(true)}
          >
            Create worker from Markdown
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="team-manager-options">
            {available.map((agent) => (
              <button
                className="team-manager-option"
                key={agent.id}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await callRoute(
                      workspaceApi.teamMemberAdd,
                      {
                        params: { id: adding.id },
                        body: { agentId: agent.id },
                      },
                      executionSourceId(),
                    );
                    onChanged();
                    setAdding(null);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Avatar name={agent.name} />
                <span>
                  <strong>@{agent.name}</strong>
                  <small>{agentModelName(agent, connections)}</small>
                </span>
                <UserPlus size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
          {!available.length && (
            <p className="muted">
              No available agents. Create or connect another agent first.
            </p>
          )}
          <button className="text-button" onClick={backToTeams}>
            Back to teams
          </button>
        </>
      ) : (
        <>
          <div className="team-manager-options">
            {teams.map((team) => {
              const workers = team.members.filter((id) =>
                agents.some((agent) => agent.id === id && !agent.retired_at),
              );
              return (
                <section className="team-directory-item" key={team.id}>
                  <button
                    className="team-manager-option"
                    onClick={() => {
                      onClose();
                      onOpen(team);
                    }}
                  >
                    <Users size={20} aria-hidden="true" />
                    <span>
                      <strong>{team.name}</strong>
                      <small>
                        Manager @{name(team.manager_id)} · {workers.length}{" "}
                        {workers.length === 1 ? "worker" : "workers"}
                      </small>
                    </span>
                    <ArrowUpRight size={18} aria-hidden="true" />
                  </button>
                  {team.preset_id === "code-review" && onReview && (
                    <button
                      className="secondary"
                      onClick={() => onReview(team)}
                    >
                      Review changes
                    </button>
                  )}
                  <p className="muted">
                    {workers.map((id) => `@${name(id)}`).join(" · ")}
                  </p>
                  <TeamFeedVisibility
                    team={team}
                    onChanged={onVisibilityChanged}
                  />
                  {team.preset_id !== "code-review" && (
                    <button
                      className="text-button"
                      disabled={workers.length >= MAX_TEAM_WORKERS}
                      onClick={() => {
                        setAdding(team);
                        setError("");
                      }}
                    >
                      <UserPlus size={16} /> Add worker
                    </button>
                  )}
                </section>
              );
            })}
          </div>
          {!teams.length && (
            <p className="muted">
              Create a team to coordinate a manager and workers.
            </p>
          )}
          <button className="primary" onClick={onCreate}>
            New team
          </button>
        </>
      )}
    </Sheet>
  );
}

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
                  <Avatar name={manager?.name} />
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

/** Existing team entrypoint shares the profile's mail controls. */
export function TeamMessages({
  team,
  onClose,
  ...props
}: {
  team: Team;
  agents: Agent[];
  sourceId: string;
  ownerKey: string;
  onClose: () => void;
  onOpenConversation: (id: string, sourceId: string) => void;
  onChanged: () => void;
}) {
  return (
    <Sheet title={`${team.name} messages`} onClose={onClose}>
      <AgentMailThreads target={{ kind: "team", id: team.id }} {...props} />
    </Sheet>
  );
}

export function TeamFilter({
  teams,
  selected,
  onChange,
  onCreate,
  onOpen,
  onMessages,
  onDeleted,
  onVisibilityChanged,
}: {
  teams: Team[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onCreate: () => void;
  onOpen: (team: Team) => void;
  onMessages: (team: Team) => void;
  onDeleted: (id: string) => void;
  onVisibilityChanged: (team: Team) => void;
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
  // A single selected team stays listed while searching, so its settings
  // and actions remain reachable.
  const named = (t: Team) =>
    t.name.toLowerCase().includes(query.toLowerCase().trim());
  const matches = teams.filter(
    (t) => named(t) || (chosen.length === 1 && chosen[0].id === t.id),
  );
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
        <Sheet
          title="Filter by team"
          onClose={close}
          footer={
            <div className="team-picker-actions">
              <button
                className="secondary"
                onClick={() => {
                  close();
                  onCreate();
                }}
              >
                <Plus size={17} aria-hidden="true" /> New team
              </button>
              <button className="primary" onClick={close}>
                Done
              </button>
            </div>
          }
        >
          <p className="muted">
            Choose the teams you want to see in your feed.
          </p>
          <label className="team-search">
            <Search size={18} aria-hidden="true" />
            <input
              {...literalEntry}
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
                <small>Your agents and teams, with hidden cards excluded</small>
              </span>
              {!selected.length && <Check size={20} />}
            </button>
            {matches.map((t) => {
              const workers = t.members.length;
              const expanded = chosen.length === 1 && chosen[0].id === t.id;
              return (
                <div
                  className={
                    "team-option-group" + (expanded ? " expanded" : "")
                  }
                  key={t.id}
                >
                  <label className="team-option">
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
                        Manager + {workers}{" "}
                        {workers === 1 ? "worker" : "workers"}
                        {!!t.paused_threads &&
                          ` · ${t.paused_threads} paused ${t.paused_threads === 1 ? "thread" : "threads"}`}
                      </small>
                    </span>
                    {!!t.hide_results_from_feed && (
                      <span
                        className="team-option-badge"
                        title="Done and Threads cards are hidden from All teams"
                      >
                        <EyeOff size={14} aria-hidden="true" /> Hidden
                      </span>
                    )}
                  </label>
                  {expanded && (
                    <div className="team-option-panel">
                      <TeamFeedVisibility
                        team={t}
                        onChanged={onVisibilityChanged}
                      />
                      <div className="team-option-actions">
                        <button
                          className="secondary"
                          onClick={() => {
                            close();
                            onOpen(t);
                          }}
                        >
                          <MessageSquare size={17} aria-hidden="true" /> Message
                          manager
                        </button>
                        <button
                          className="secondary"
                          onClick={() => {
                            close();
                            onMessages(t);
                          }}
                        >
                          <Mail size={17} aria-hidden="true" /> Messages
                          {!!t.paused_threads &&
                            ` · ${t.paused_threads} paused`}
                        </button>
                        <button
                          className="secondary danger"
                          onClick={() => {
                            setError("");
                            setDeleting(t);
                          }}
                        >
                          <Trash2 size={17} aria-hidden="true" /> Delete team
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!teams.length && (
              <p className="muted">Create a team to give it its own feed.</p>
            )}
            {teams.length > 0 && !teams.some(named) && (
              <p className="muted" role="status">
                No teams match “{query}”.
              </p>
            )}
          </div>
          {chosen.length > 1 && (
            <p className="muted">
              Select a single team to change its settings or message its
              manager.
            </p>
          )}
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
                  await callRoute(
                    workspaceApi.teamDelete,
                    { params: { id: deleting.id } },
                    executionSourceId(),
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
  connections,
  onClose,
  onCreated,
  onCreateAgent,
  folders = [],
  initialFolder,
  initialPreset,
}: {
  agents: Agent[];
  connections: Connection[];
  onClose: () => void;
  onCreated: (t: Team) => void;
  onCreateAgent: () => void;
  folders?: Folder[];
  initialFolder?: string;
  initialPreset?: string;
}) {
  const [preset, setPreset] = useState<TeamPreset | null>(
    TEAM_PRESETS.find((p) => p.id === initialPreset) || null,
  );
  const [definitionsOpen, setDefinitionsOpen] = useState(false);
  const [definition, setDefinition] = useState<AgentDefinition>();
  const available = agents.filter(
    (agent) =>
      !agent.retired_at &&
      connections.some(
        (connection) =>
          connection.id === agent.connection_id &&
          connection.status === "connected",
      ),
  );
  const [name, setName] = useState(""),
    [manager, setManager] = useState(available[0]?.id || ""),
    [members, setMembers] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (definitionsOpen)
    return (
      <MarkdownDefinitions
        key={executionSourceId()}
        kind="team"
        sourceId={executionSourceId()}
        onClose={() => setDefinitionsOpen(false)}
        onUse={(item) => {
          setDefinition(item);
          setDefinitionsOpen(false);
        }}
      />
    );
  if (definition)
    return (
      <CreateFromDefinition
        key={`${executionSourceId()}:${definition.id}:${definition.version}`}
        definition={definition}
        sourceId={executionSourceId()}
        connections={connections}
        folders={folders}
        initialFolder={initialFolder}
        onClose={() => setDefinition(undefined)}
        onCreated={(result) => {
          if (result.team) onCreated(result.team);
        }}
      />
    );
  return (
    <Sheet title="Create an agent team" onClose={onClose}>
      <button className="text-button" onClick={() => setDefinitionsOpen(true)}>
        From Markdown
      </button>
      <PresetPicker selected={preset?.id || null} onSelect={setPreset} />
      {preset ? (
        <PresetTeamForm
          key={preset.id}
          preset={preset}
          connections={connections}
          folders={folders}
          initialFolder={initialFolder}
          onCreated={onCreated}
        />
      ) : (
        <>
          <p>
            Talk to the manager. It delegates tasks to workers, whose updates
            appear in this team's feed and in All teams.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                onCreated(
                  await callRoute(
                    workspaceApi.teamCreate,
                    { body: { name, managerId: manager, members } },
                    executionSourceId(),
                  ),
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
                {...proseEntry}
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
                    @{a.name} · {agentModelName(a, connections)}
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
                    <span>
                      @{a.name}{" "}
                      <span className="muted">
                        · {agentModelName(a, connections)}
                      </span>
                    </span>
                  </label>
                ))}
            </fieldset>
            <button
              type="button"
              className="text-button"
              onClick={onCreateAgent}
            >
              Create another agent
            </button>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button
              className="primary"
              disabled={
                busy ||
                !manager ||
                !members.length ||
                members.length > MAX_TEAM_WORKERS
              }
            >
              {busy ? "Creating…" : "Create team & talk to manager"}
            </button>
          </form>
        </>
      )}
    </Sheet>
  );
}
