import { useSourceRoute } from "./SourceContext";
import { workspaceApi } from "../shared/workspace-api";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Sheet } from "./components";
import { effortName, modelGroups, modelDisplayName } from "./modelChoices";
import type { Agent, Connection } from "../shared/types";
import type { ModelOption } from "../shared/models";

// Radio-style choices support the same arrow navigation as native radio inputs.
function navigateChoices(event: KeyboardEvent<HTMLDivElement>) {
  if (
    ![
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  const choices = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]:not(:disabled)',
    ),
  ];
  if (!choices.length) return;
  const index = choices.findIndex((choice) => choice === event.target);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? choices.length - 1
        : (index +
            (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) +
            choices.length) %
          choices.length;
  choices[next].focus();
  choices[next].click();
}

export function AgentModelSettings({
  agent,
  connections,
  onClose,
  onSaved,
}: {
  agent: Agent;
  connections: Connection[];
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const route = useSourceRoute();
  const [selected, setSelected] = useState(agent);
  const [catalog, setCatalog] = useState<Record<string, ModelOption[]>>({});
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false),
    [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(true),
    [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const connectionKey = connections
    .filter((c) => c.status === "connected")
    .map((c) => c.id)
    .join(",");
  useEffect(() => {
    let current = true;
    setRefreshing(true);
    setStale(false);
    void Promise.all(
      connectionsRef.current
        .filter((c) => c.status === "connected")
        .map(async (connection) => {
          try {
            const result = await route(workspaceApi.connectionModels, {
              params: { id: connection.id },
            });
            if (current)
              setCatalog((old) => ({ ...old, [connection.id]: result.models }));
          } catch {
            if (current) setStale(true);
          }
        }),
    ).finally(() => {
      if (current) setRefreshing(false);
    });
    return () => {
      current = false;
    };
  }, [connectionKey, revision]);
  const groups = modelGroups(connections, catalog);
  const chosen = groups
    .find((group) => group.connection.id === selected.connection_id)
    ?.models.find((model) => model.id === selected.model);
  const levels = chosen?.effortLevels || [];
  const matches = groups.map((group) => ({
    ...group,
    models: group.models.filter((model) =>
      `${modelDisplayName(model)} ${model.name} ${model.id} ${group.name} ${group.connection.label}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    ),
  }));
  async function save(
    connectionId: string,
    model: string,
    effort: string | null,
  ) {
    if (locked.current) return;
    if (
      connectionId === selected.connection_id &&
      model === selected.model &&
      effort === (selected.effort || null)
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await route(workspaceApi.agentUpdate, {
        params: { id: agent.id },
        body: { connectionId, model, effort },
      });
      setSelected(saved);
      onSaved(saved);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Select model"
      className="model-picker-sheet"
      swipeToClose
      onClose={onClose}
    >
      <p className="model-picker-context">
        For @{agent.name} · changes save for future runs
      </p>
      <div className="model-effort">
        <button
          type="button"
          className="effort-trigger"
          aria-expanded={effortOpen}
          aria-controls="model-effort-options"
          disabled={!levels.length || busy}
          onClick={() => setEffortOpen(!effortOpen)}
        >
          <strong>Effort</strong>
          <span>
            {selected.effort
              ? effortName(selected.effort)
              : chosen?.defaultEffort
                ? `${effortName(chosen.defaultEffort)} (default)`
                : "Runtime default"}
          </span>
          {effortOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {effortOpen && levels.length > 0 && (
          <div
            id="model-effort-options"
            className="effort-options"
            role="radiogroup"
            onKeyDown={navigateChoices}
            aria-label="Effort"
          >
            {[
              { value: "", description: "Use the runtime’s default effort." },
              ...levels,
            ].map((level) => (
              <button
                type="button"
                role="radio"
                aria-checked={(selected.effort || "") === level.value}
                disabled={busy}
                key={level.value}
                onClick={() =>
                  void save(
                    selected.connection_id!,
                    selected.model,
                    level.value || null,
                  )
                }
              >
                <span>
                  <strong>{effortName(level.value)}</strong>
                  {level.description && <small>{level.description}</small>}
                </span>
                {(selected.effort || "") === level.value && <Check size={20} />}
              </button>
            ))}
          </div>
        )}
        {!levels.length && (
          <p className="field-hint">
            This model hasn’t reported adjustable effort options.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <input
        type="search"
        className="model-search"
        aria-label="Search models"
        placeholder="Search models…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        role="radiogroup"
        onKeyDown={navigateChoices}
        aria-label="Models"
        className="model-catalog"
        aria-busy={busy}
      >
        {matches
          .filter((group) => group.models.length)
          .map((group) => (
            <section
              className="model-group"
              key={group.connection.id}
              aria-label={`${group.name} models`}
            >
              <div className="model-group-heading">
                <h3>{group.name}</h3>
                <span>{group.connection.label}</span>
              </div>
              <div className="model-options">
                {group.models.map((model) => {
                  const active =
                    group.connection.id === selected.connection_id &&
                    model.id === selected.model;
                  return (
                    <button
                      type="button"
                      className="model-option"
                      role="radio"
                      aria-label={`${modelDisplayName(model)} · ${group.name} · ${group.connection.label}`}
                      aria-checked={active}
                      disabled={busy}
                      key={model.id}
                      onClick={() => {
                        setEffortOpen(false);
                        void save(
                          group.connection.id,
                          model.id,
                          active ? selected.effort || null : null,
                        );
                      }}
                    >
                      <span>{modelDisplayName(model)}</span>
                      {active && <Check size={21} />}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
      </div>
      {!matches.some((group) => group.models.length) && (
        <p className="muted">
          {query
            ? "No models match your search."
            : refreshing
              ? "Loading models from your connected harnesses…"
              : "Connect a provider in Settings to choose a model."}
        </p>
      )}
      <div className="model-picker-status">
        {busy ? (
          <p role="status">Saving selection…</p>
        ) : refreshing ? (
          <p role="status">Refreshing model lists…</p>
        ) : stale ? (
          <p className="field-hint">
            Some harnesses are unavailable. Their saved model lists are shown.{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh
            </button>
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="primary model-picker-done"
        onClick={onClose}
        disabled={busy}
      >
        Done
      </button>
    </Sheet>
  );
}
