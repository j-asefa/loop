import type { ReactNode } from "react";
import type { ModelOption } from "../shared/models";
import { EffortSelect } from "./EffortSelect";

export function ConnectionModelPicker({
  connections,
  connection,
  models,
  model,
  onConnection,
  onModel,
  connectionLabel = "Connection",
  modelLabel = "Model",
  connectionAriaLabel,
  modelAriaLabel,
  modelDisabled,
  modelPlaceholder,
  modelNotice,
  effort,
}: {
  connections: { id: string; label: string }[];
  connection: string;
  models: { id: string; name?: string }[];
  model: string;
  onConnection: (id: string) => void;
  onModel: (id: string) => void;
  connectionLabel?: string;
  modelLabel?: string;
  connectionAriaLabel: string;
  modelAriaLabel: string;
  modelDisabled?: boolean;
  modelPlaceholder?: ReactNode;
  modelNotice?: ReactNode;
  effort?: {
    model?: ModelOption;
    value: string;
    label: string;
    onChange: (value: string) => void;
  };
}) {
  return (
    <>
      <label>
        {connectionLabel}
        <select
          aria-label={connectionAriaLabel}
          value={connection}
          onChange={(event) => onConnection(event.target.value)}
        >
          <option value="">Choose a connection</option>
          {connections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {modelLabel}
        <select
          aria-label={modelAriaLabel}
          value={model}
          disabled={modelDisabled}
          onChange={(event) => onModel(event.target.value)}
        >
          {modelPlaceholder === undefined ? (
            <option value="">Choose a model</option>
          ) : (
            modelPlaceholder
          )}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name || item.id}
            </option>
          ))}
        </select>
      </label>
      {modelNotice}
      {effort && <EffortSelect {...effort} compact />}
    </>
  );
}
