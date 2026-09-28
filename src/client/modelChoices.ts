import type { Connection } from "../shared/types";
import type { ModelOption } from "../shared/models";
import { parse } from "./api";

export function harnessName(connection: Connection) {
  const metadata = parse<any>(connection.metadata, {});
  if (connection.provider === "codex") return "Codex";
  if (connection.provider === "anthropic")
    return metadata.authMode === "subscription" ||
      metadata.loopHarness === "claude"
      ? "Claude Code"
      : "Claude API";
  return {
    openai: "OpenAI API",
    pi: "Pi",
    opencode: "OpenCode",
    acp: "ACP agent",
  }[connection.provider];
}
export function modelGroups(
  connections: Connection[],
  catalog: Record<string, ModelOption[]> = {},
) {
  return connections
    .filter((connection) => connection.status === "connected")
    .map((connection) => ({
      connection,
      name: harnessName(connection),
      models: [
        ...new Map(
          (
            catalog[connection.id] ??
            parse<ModelOption[]>(connection.models, [])
          )
            .filter((model) => model.id)
            .map((model) => [model.id, model]),
        ).values(),
      ],
    }));
}
export function effortName(value?: string | null) {
  if (!value) return "Default";
  if (value === "xhigh") return "Extra high";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
export function agentModelName(
  agent: { connection_id: string | null; model: string },
  connections: Connection[],
) {
  const models = parse<ModelOption[]>(
    connections.find((c) => c.id === agent.connection_id)?.models,
    [],
  );
  return modelDisplayName(
    models.find((model) => model.id === agent.model) || {
      id: agent.model,
      name: agent.model,
    },
  );
}

export function runModelName(
  snapshot: {
    model?: unknown;
    resolvedModel?: unknown;
    connectionId?: unknown;
    provider?: unknown;
  },
  connections: Connection[],
) {
  // Prefer an execution-time identity when one was recorded. Older runs only
  // saved an alias, so resolve it using their own connection's model catalog,
  // never the agent's current model or a different account's default.
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
  return agentModelName(
    { connection_id: connection?.id || null, model: snapshot.model },
    connections,
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
  // A catalog may use friendly aliases as names. Only the harness can resolve
  // those aliases; do not hardcode the model version an alias should select.
  return model.resolvedModel || model.name || model.id;
}
