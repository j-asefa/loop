import type { ModelOption } from "../shared/models";

export function EffortSelect({
  model,
  value,
  onChange,
}: {
  model?: ModelOption;
  value: string;
  onChange: (effort: string) => void;
}) {
  const levels = model?.effortLevels || [];
  return (
    <label>
      Effort
      <select
        name="effort"
        aria-label="Effort"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={!levels.length}
      >
        <option value="">
          {model?.defaultEffort
            ? `Runtime default (${model.defaultEffort})`
            : "Runtime default"}
        </option>
        {levels.map((level) => (
          <option key={level.value} value={level.value}>
            {level.value[0].toUpperCase() + level.value.slice(1)}
          </option>
        ))}
      </select>
      <span className="field-hint">
        {levels.find((level) => level.value === value)?.description ||
          (levels.length
            ? "Options reported by this model’s provider."
            : model?.id === "default" || model?.id === "native-default"
              ? "Choose a specific model to see its available effort levels."
              : "This provider hasn’t reported adjustable effort levels for this model.")}
      </span>
    </label>
  );
}
