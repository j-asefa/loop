import { useId, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Cpu,
  Monitor,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { ModelOption } from "../shared/models";
import type { EnvironmentConnection } from "./agentSources";
import {
  connectionLocation,
  effortName,
  harnessName,
  modelDisplayName,
  modelOptionLabel,
} from "./modelChoices";
import { EffortSelect } from "./EffortSelect";
import { ConnectionDetails } from "./ConnectionDetails";
import { literalEntry } from "./textEntry";

export const connectionKey = (connection: EnvironmentConnection) =>
  JSON.stringify([connection.sourceId || "", connection.id]);

const locationName = (connection: EnvironmentConnection) =>
  connection.executionEnvironment || connectionLocation(connection).label;

export function CreateAgentModelOptions({
  connections,
  selected,
  models,
  model,
  effort,
  disabled,
  refreshing,
  onConnectionChange,
  onModelChange,
  onEffortChange,
  onRefresh,
  onConnect,
  children,
}: {
  connections: EnvironmentConnection[];
  selected?: EnvironmentConnection;
  models: ModelOption[];
  model: string;
  effort: string;
  disabled: boolean;
  refreshing: boolean;
  onConnectionChange: (connection: EnvironmentConnection) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onRefresh: () => void;
  onConnect: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const connectionName = useId(),
    modelName = useId(),
    selectionId = useId();
  const chosen = models.find((option) => option.id === model);
  const matches = models.filter((option) =>
    `${modelOptionLabel(option)} ${option.id} ${option.resolvedModel || ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const visibleModels = matches.slice(0, visibleCount);
  if (chosen && matches.includes(chosen) && !visibleModels.includes(chosen))
    visibleModels.unshift(chosen);
  return (
    <details
      className="create-agent-model-options"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="Model and connection" aria-describedby={selectionId}>
        <Cpu size={20} aria-hidden="true" />
        <span className="create-agent-selection" id={selectionId}>
          <small>Model & connection</small>
          <strong>
            {chosen
              ? modelOptionLabel(chosen)
              : refreshing
                ? "Checking available models…"
                : "Choose a model"}
          </strong>
          {chosen?.resolvedModel && <small>{modelDisplayName(chosen)}</small>}
          <small>
            {selected
              ? `${harnessName(selected)} · ${locationName(selected)}`
              : "Choose a connected account"}
          </small>
          {effort && <small>{effortName(effort)} effort</small>}
        </span>
        <ChevronDown
          className="create-agent-selection-chevron"
          size={18}
          aria-hidden="true"
        />
      </summary>
      {open && (
        <div className="create-agent-model-body">
          <fieldset disabled={disabled} className="create-agent-choices">
            <legend>Connection</legend>
            <p className="field-hint">
              The account and computer your agent uses.
            </p>
            <div
              className="create-agent-connections"
              role="radiogroup"
              aria-label="Connection"
            >
              {connections.map((connection) => {
                const key = connectionKey(connection);
                const title = harnessName(connection);
                const location = locationName(connection);
                return (
                  <label className="create-agent-choice" key={key}>
                    <input
                      type="radio"
                      name={connectionName}
                      value={key}
                      data-provider={connection.provider}
                      data-connection-id={connection.id}
                      data-source-id={connection.sourceId || ""}
                      aria-label={`${title} · ${connection.label} · ${location}`}
                      checked={!!selected && key === connectionKey(selected)}
                      onChange={() => {
                        setQuery("");
                        setVisibleCount(50);
                        onConnectionChange(connection);
                      }}
                    />
                    <span>
                      <strong>{title}</strong>
                      <small>{connection.label}</small>
                      <small className="create-agent-location">
                        <Monitor size={13} aria-hidden="true" />
                        {location}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            <details className="create-agent-more-connections">
              <summary>More connection options</summary>
              <button type="button" className="text-button" onClick={onConnect}>
                <Plus size={16} /> Connect another account
              </button>
              {children}
            </details>
          </fieldset>
          {selected && (
            <>
              <fieldset
                disabled={disabled || refreshing}
                className="create-agent-choices create-agent-models"
              >
                <legend>Model</legend>
                <div className="create-agent-model-heading">
                  <p className="field-hint">
                    The AI that responds to your messages.
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setQuery("");
                      setVisibleCount(50);
                      onRefresh();
                    }}
                    disabled={refreshing}
                  >
                    <RefreshCw size={14} aria-hidden="true" /> Refresh models
                  </button>
                </div>
                {(models.length > 6 || !!query) && (
                  <label className="create-agent-model-search">
                    <Search size={16} aria-hidden="true" />
                    <input
                      {...literalEntry}
                      type="search"
                      aria-label="Search models"
                      placeholder="Search models…"
                      value={query}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setVisibleCount(50);
                      }}
                    />
                  </label>
                )}
                {refreshing ? (
                  <p className="field-hint" role="status">
                    Checking available models…
                  </p>
                ) : (
                  <div
                    className="create-agent-model-list"
                    role="radiogroup"
                    aria-label="Model"
                  >
                    {visibleModels.map((option) => (
                      <label className="create-agent-choice" key={option.id}>
                        <input
                          type="radio"
                          name={modelName}
                          value={option.id}
                          aria-label={modelOptionLabel(option)}
                          checked={model === option.id}
                          onChange={() => onModelChange(option.id)}
                        />
                        <span>
                          <strong>{modelOptionLabel(option)}</strong>
                          {["default", "native-default"].includes(
                            option.id,
                          ) && (
                            <small>
                              {option.resolvedModel
                                ? `Currently ${option.resolvedModel}`
                                : `Follows your ${harnessName(selected)} settings`}
                            </small>
                          )}
                        </span>
                      </label>
                    ))}
                    {!matches.length && (
                      <p className="field-hint">
                        {query
                          ? "No models match your search."
                          : "No models available. Try refreshing."}
                      </p>
                    )}
                  </div>
                )}
                {!refreshing && matches.length > visibleModels.length && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setVisibleCount((count) => count + 50)}
                  >
                    Show more models ({matches.length - visibleModels.length}{" "}
                    remaining)
                  </button>
                )}
                {(!!chosen?.effortLevels?.length || !!effort) && (
                  <div className="create-agent-effort">
                    <EffortSelect
                      model={chosen}
                      value={effort}
                      onChange={onEffortChange}
                    />
                  </div>
                )}
              </fieldset>
              <details className="create-agent-connection-info">
                <summary>Connection details & billing</summary>
                <ConnectionDetails connection={selected} />
              </details>
            </>
          )}
        </div>
      )}
    </details>
  );
}
