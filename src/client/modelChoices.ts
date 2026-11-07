import type { Connection } from "../shared/types";
import type { ModelOption } from "../shared/models";
import { parse } from "./api";
import { modelDisplayName } from "../shared/model-display";
export { modelDisplayName, runModelName } from "../shared/model-display";

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
    antigravity: "Antigravity",

    muse: "Muse Code",
    grok: "Grok Build",
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
/** A harness default stays labelled as a default when choosing it; the model
 * it resolved to is shown where the saved choice is displayed. */
export function modelOptionLabel(model: ModelOption) {
  return model.id === "default" || model.id === "native-default"
    ? model.name || "Default"
    : modelDisplayName(model);
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

export type ExecutionLocation = "laptop" | "docker";
export const executionLocationLabels: Record<ExecutionLocation, string> = {
  laptop: "This computer",
  docker: "Docker",
};

/**
 * Where a connection runs, from the location the server recorded when it was
 * registered. This is saved information, not a live host check.
 */
export function connectionLocation(
  connection?: Connection,
  localName?: string,
): {
  kind: ExecutionLocation | null;
  label: string;
} {
  const parsed = parse<unknown>(connection?.metadata, {});
  const metadata = (
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  ) as Record<string, unknown>;
  const kind =
    metadata.location === "laptop" || metadata.location === "docker"
      ? metadata.location
      : null;
  const name =
    typeof metadata.environmentName === "string"
      ? metadata.environmentName.trim()
      : "";
  const named =
    name &&
    name !== "This laptop" &&
    name !== "This computer" &&
    name !== "Docker";
  if (kind === "docker")
    return {
      kind,
      label: named
        ? name.startsWith("Docker · ")
          ? name
          : `Docker · ${name}`
        : localName?.startsWith("Docker · ")
          ? localName
          : executionLocationLabels.docker,
    };
  if (kind)
    return {
      kind,
      label:
        name && name !== "This laptop" && name !== "This computer"
          ? name
          : localName || executionLocationLabels.laptop,
    };
  return {
    kind,
    label: metadata.loopHarness ? "This computer" : "Server connection",
  };
}
