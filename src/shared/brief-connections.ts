import type { Connection } from "./types.js";

/** The settings selector and worker must agree on supported billing paths. */
export function canGenerateBrief(
  connection: Pick<Connection, "provider" | "metadata">,
) {
  let metadata;
  try {
    metadata = JSON.parse(connection.metadata);
  } catch {
    return false;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return false;
  if (metadata.loopHarness != null)
    return (
      metadata.authMode === "subscription" &&
      ((metadata.loopHarness === "codex" && connection.provider === "codex") ||
        (metadata.loopHarness === "claude" &&
          connection.provider === "anthropic"))
    );
  return metadata.authMode === "subscription"
    ? ["codex", "anthropic"].includes(connection.provider)
    : ["openai", "anthropic"].includes(connection.provider);
}

/** Claude's configured default depends on settings omitted by brief sessions. */
export function canSelectBriefModel(
  connection: Pick<Connection, "provider">,
  model: string,
) {
  return model !== "native-default" || connection.provider !== "anthropic";
}
