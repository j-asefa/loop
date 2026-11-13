import { ModelId } from "../shared/contract-ids.js";
import {
  ConnectionId,
  FolderId,
  parseId,
  TeamPresetId,
} from "../shared/contract-ids.js";
import { proseEntry } from "./textEntry";
import { useEffect, useRef, useState } from "react";
import { callRoute } from "./api";
import { workspaceApi } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
import { performStoredEffect, creationFailureSettled } from "./pendingCommands";
import { viewOwner, viewGeneration } from "./viewCache";
import { TEAM_PRESETS, type TeamPreset } from "../shared/team-presets";
import type { Connection, Folder, Team } from "../shared/types";

type Choice = { connectionId: ConnectionId; model: string };
const models = (c?: Connection): { id: string; name?: string }[] => {
  try {
    return JSON.parse(c?.models || "[]");
  } catch {
    return [];
  }
};
export function PresetPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (p: TeamPreset | null) => void;
}) {
  return (
    <div className="team-preset-options" role="group" aria-label="Team purpose">
      {TEAM_PRESETS.map((p) => (
        <button
          type="button"
          key={p.id}
          className="team-preset-option"
          aria-pressed={selected === p.id}
          onClick={() => onSelect(p)}
        >
          <strong>{p.name}</strong>
          <small>{p.description}</small>
        </button>
      ))}
      <button
        type="button"
        className="team-preset-option"
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        <strong>Custom team</strong>
        <small>Choose existing agents and define your own process.</small>
      </button>
    </div>
  );
}

export function PresetTeamForm({
  preset,
  connections,
  folders,
  initialFolder,
  onCreated,
}: {
  preset: TeamPreset;
  connections: Connection[];
  folders: Folder[];
  initialFolder?: string;
  onCreated: (team: Team) => void;
}) {
  const available = connections.filter(
    (c) => c.status === "connected" && models(c).length,
  );
  const first = available[0];
  const [name, setName] = useState(preset.name);
  const [folder, setFolder] = useState(
    initialFolder || folders.find((f) => f.kind === "project")?.id || "",
  );
  const [selection, setSelection] = useState<Choice>({
    connectionId: parseId(ConnectionId, first?.id || ""),
    model: models(first)[0]?.id || "",
  });
  const [roles, setRoles] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const owner = viewOwner(),
    generation = viewGeneration(),
    source = executionSourceId();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    owner === viewOwner() &&
    generation === viewGeneration() &&
    source === executionSourceId();
  function chooser(label: string, value: Choice, change: (c: Choice) => void) {
    return (
      <fieldset>
        <legend>{label}</legend>
        <label>
          Connection
          <select
            aria-label={`${label} connection`}
            value={value.connectionId}
            onChange={(e) => {
              const c = available.find((c) => c.id === e.target.value);
              change({
                connectionId: parseId(ConnectionId, c?.id || ""),
                model: models(c)[0]?.id || "",
              });
            }}
          >
            <option value="">Choose a connection</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select
            aria-label={`${label} model`}
            value={value.model}
            onChange={(e) => change({ ...value, model: e.target.value })}
          >
            <option value="">Choose a model</option>
            {models(available.find((c) => c.id === value.connectionId)).map(
              (m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ),
            )}
          </select>
        </label>
      </fieldset>
    );
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        const body = {
          presetId: TeamPresetId.parse(preset.id),
          name,
          folderId: parseId(FolderId, folder),
          selection: { ...selection, model: parseId(ModelId, selection.model) },
          roles: Object.fromEntries(
            Object.entries(roles).map(([role, choice]) => [
              role,
              { ...choice, model: parseId(ModelId, choice.model) },
            ]),
          ),
        };
        const encoded = JSON.stringify(body);
        try {
          const team = await performStoredEffect(
            localStorage,
            owner,
            source,
            ["team-create", encoded],
            current,
            (idempotencyKey) =>
              callRoute(
                workspaceApi.teamFromPreset,
                { body: { ...body, idempotencyKey } },
                source,
              ),
            creationFailureSettled,
          );
          if (current()) onCreated(team);
        } catch (e) {
          if (current()) setError((e as Error).message);
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <p>
        Loop creates {preset.roles.length} agents with these roles:{" "}
        {preset.roles.map((r) => r.name).join(", ")}. You can change their
        settings later.
      </p>
      {preset.id === "code-review" && (
        <p className="muted">
          Reviews run on a laptop workspace bound to a Git repository. Usage is
          billed by your selected connections.
        </p>
      )}
      {preset.id === "llm-council" && (
        <p className="muted">
          Choose a different model for each member. A council of one model
          mostly agrees with itself.
        </p>
      )}
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
        Project
        <select
          aria-label="Project"
          required
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        >
          <option value="">Choose a project</option>
          {folders
            .filter((f) => f.kind === "project")
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </label>
      {!folders.some((f) => f.kind === "project") && (
        <p className="muted">Create a project first from Projects.</p>
      )}
      {chooser("Default for all roles", selection, setSelection)}
      <details open={preset.id === "llm-council"}>
        <summary>Customize connections by role</summary>
        {preset.roles.map((r) => (
          <div key={r.id}>
            {chooser(r.name, roles[r.id] || selection, (c) =>
              setRoles({ ...roles, [r.id]: c }),
            )}
            {roles[r.id] && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setRoles(
                    Object.fromEntries(
                      Object.entries(roles).filter(([key]) => key !== r.id),
                    ),
                  )
                }
              >
                Use default for {r.name.toLowerCase()}
              </button>
            )}
          </div>
        ))}
      </details>
      {!available.length && (
        <p role="status">
          No connected providers. Add a connection in Settings first.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={
          busy ||
          !folder ||
          !selection.connectionId ||
          !selection.model ||
          Object.values(roles).some((r) => !r.connectionId || !r.model)
        }
      >
        {busy ? "Creating…" : "Create team"}
      </button>
    </form>
  );
}
