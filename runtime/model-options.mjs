// Preserve model capabilities reported by the provider; never infer effort
// levels from a model name or silently substitute a different level.
export function modelOptions(model) {
  const reported =
    model.supportedReasoningEfforts ?? model.supportedEffortLevels;
  const capability = model.capabilities?.effort;
  const levels = Array.isArray(reported)
    ? reported.map((level) =>
        typeof level === "string"
          ? { value: level }
          : { value: level.reasoningEffort, description: level.description },
      )
    : capability
      ? Object.entries(capability)
          .filter(
            ([key, value]) => key !== "supported" && value?.supported === true,
          )
          .map(([value]) => ({ value }))
      : model.supportsEffort === false
        ? []
        : undefined;
  const effortLevels = levels?.filter(
    (level) =>
      typeof level.value === "string" &&
      /^[a-z][a-z0-9_-]{0,31}$/.test(level.value),
  );
  const defaultEffort =
    model.defaultReasoningEffort ?? model.defaultEffortLevel;
  return {
    ...(typeof model.resolvedModel === "string" &&
    model.resolvedModel.trim().length > 0 &&
    model.resolvedModel.length <= 200
      ? { resolvedModel: model.resolvedModel.trim() }
      : {}),
    ...(effortLevels ? { effortLevels } : {}),
    ...(typeof defaultEffort === "string" ? { defaultEffort } : {}),
  };
}
