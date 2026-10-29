import type { ReactNode } from "react";
import type { ModelOption } from "../shared/models";
import { modelOptionLabel } from "./modelChoices";

/** Shared native selects for agent creation. */
export function ConnectionPicker({
  value,
  onChange,
  disabled,
  children,
  label = "Run on",
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
  label?: string;
}) {
  return (
    <label>
      {label}
      <select
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  refreshing = false,
}: {
  models: ModelOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  refreshing?: boolean;
}) {
  return (
    <label>
      Model
      <select
        aria-label="Model"
        disabled={disabled || !models.length}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {!!models.length && !models.some((model) => model.id === value) && (
          <option value="" disabled>
            Choose a model
          </option>
        )}
        {!models.length && (
          <option value="">
            {refreshing ? "Checking available models…" : "No models available"}
          </option>
        )}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {modelOptionLabel(model)}
          </option>
        ))}
      </select>
    </label>
  );
}
