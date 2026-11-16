import type { ModelOption } from "../shared/models";

export function EffortSelect({
  model,
  value,
  onChange,
  label = "Effort",
  compact = false,
}: {
  model?: ModelOption;
  value: string;
  onChange: (effort: string) => void;
  label?: string;
  compact?: boolean;
}) {
  const levels = model?.effortLevels || [];
  return (
    <label>
      {label}
      <select
        name={compact ? undefined : "effort"}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={!levels.length && !value}
      >
        <option value="">
          {compact
            ? "Default"
            : model?.defaultEffort
              ? `Runtime default (${model.defaultEffort})`
              : "Runtime default"}
        </option>
        {value && !levels.some((level) => level.value === value) && (
          <option value={value}>
            {compact ? value : `${value} (not reported by this model)`}
          </option>
        )}
        {levels.map((level) => (
          <option key={level.value} value={level.value}>
            {compact
              ? level.value
              : level.value[0].toUpperCase() + level.value.slice(1)}
          </option>
        ))}
      </select>
      {!compact && (
        <span className="field-hint">
          {levels.find((level) => level.value === value)?.description ||
            (levels.length
              ? "Options reported by this model’s provider."
              : model?.id === "default" || model?.id === "native-default"
                ? "Choose a specific model to see its available effort levels."
                : "This provider hasn’t reported adjustable effort levels for this model.")}
        </span>
      )}
    </label>
  );
}
