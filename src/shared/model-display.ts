import type { ModelOption } from "./models.js";

type ModelConnection = { id: string; provider: string; models: string };

/** Resolve only the recorded execution identity or its own saved account's
 * catalog. A missing account never borrows another account's default. */
export function runModelName(
  snapshot: {
    model?: unknown;
    resolvedModel?: unknown;
    connectionId?: unknown;
    provider?: unknown;
  },
  connections: ModelConnection[],
) {
  if (typeof snapshot.resolvedModel === "string" && snapshot.resolvedModel)
    return modelDisplayName({
      id: snapshot.resolvedModel,
      name: snapshot.resolvedModel,
    });
  if (typeof snapshot.model !== "string" || !snapshot.model) return "";
  const connection = connections.find(
    (c) =>
      c.id === snapshot.connectionId &&
      (!snapshot.provider || c.provider === snapshot.provider),
  );
  let models: ModelOption[] = [];
  try {
    const parsed: unknown = JSON.parse(connection?.models || "[]");
    if (Array.isArray(parsed))
      models = parsed.flatMap((model) =>
        model && typeof model.id === "string"
          ? [
              {
                id: model.id,
                name: typeof model.name === "string" ? model.name : model.id,
                ...(typeof model.resolvedModel === "string"
                  ? { resolvedModel: model.resolvedModel }
                  : {}),
              },
            ]
          : [],
      );
  } catch {
    /* An absent or invalid catalog leaves the stored alias intact. */
  }
  return modelDisplayName(
    models.find((model) => model.id === snapshot.model) || {
      id: snapshot.model,
      name: snapshot.model,
    },
  );
}

export function modelDisplayName(model: ModelOption) {
  const id = model.resolvedModel || model.id;
  const claude = id.match(
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i,
  );
  if (claude) {
    const [, family, major, minor, context] = claude;
    return `Claude ${family[0].toUpperCase() + family.slice(1)} ${major}${minor ? "." + minor : ""}${context ? " (1M)" : ""}`;
  }
  return model.resolvedModel || model.name || model.id;
}
