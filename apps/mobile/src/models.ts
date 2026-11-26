import type { ApiAgent, ApiConnection } from "./api/types";

type CatalogModel = { id: string; name: string; resolvedModel?: string };

const HARNESS_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  muse: "Muse Code",
  grok: "Grok Build",
  acp: "ACP agent",
  openai: "OpenAI API",
};

function parseJson(text: string | null | undefined): unknown {
  try {
    return JSON.parse(text || "null");
  } catch {
    return null;
  }
}

function catalog(connection?: ApiConnection): CatalogModel[] {
  const parsed = parseJson(connection?.models);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((m) =>
    m && typeof m.id === "string" && m.id
      ? [
          {
            id: m.id,
            name: typeof m.name === "string" && m.name ? m.name : m.id,
            ...(typeof m.resolvedModel === "string" && m.resolvedModel
              ? { resolvedModel: m.resolvedModel }
              : {}),
          },
        ]
      : [],
  );
}

/** The harness a connection runs, as the web app names it. */
export function harnessLabel(connection?: ApiConnection): string {
  if (!connection) return "";
  if (connection.provider === "anthropic") {
    const meta = parseJson(connection.metadata) as {
      authMode?: string;
      loopHarness?: string;
    } | null;
    return meta?.authMode === "subscription" || meta?.loopHarness === "claude"
      ? "Claude Code"
      : "Claude API";
  }
  return HARNESS_LABELS[connection.provider] ?? connection.provider;
}

/** A readable name for a model id: Claude ids become "Claude Opus 5.5" and a
 * routing prefix such as "anthropic/" is dropped. */
export function modelIdLabel(id: string): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const claude = bare.match(
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i,
  );
  if (claude) {
    const [, family, major, minor, context] = claude;
    return `Claude ${family[0].toUpperCase() + family.slice(1)} ${major}${minor ? "." + minor : ""}${context ? " (1M)" : ""}`;
  }
  return bare;
}

function isDefaultId(id: string) {
  return id === "native-default" || id === "default";
}

/**
 * The model an agent runs, read from its own connection's catalog. A harness
 * default shows the model it resolved to, or "<harness> default" when the
 * harness did not report one. Never borrows another connection's catalog.
 */
export function agentModelLabel(
  agent: Pick<ApiAgent, "model" | "connection_id">,
  connections: ApiConnection[],
): string {
  const connection = connections.find((c) => c.id === agent.connection_id);
  const models = catalog(connection);
  const option = models.find((m) => m.id === agent.model);
  const resolved =
    option?.resolvedModel || (isDefaultId(agent.model) ? "" : agent.model);
  if (resolved) {
    const named = models.find(
      (m) => m.id === resolved && !isDefaultId(m.id) && m.name !== m.id,
    );
    if (named) return modelIdLabel(named.name);
    if (option && !option.resolvedModel && option.name !== option.id)
      return modelIdLabel(option.name);
    return modelIdLabel(resolved);
  }
  const harness = harnessLabel(connection);
  return harness ? `${harness} default` : "Default model";
}

/** Connected harnesses a new agent can start on, in the order the web app
 * offers them: subscription sign-ins before API keys. */
export function connectedHarnesses(
  connections: ApiConnection[],
): ApiConnection[] {
  const isSub = (c: ApiConnection) =>
    (parseJson(c.metadata) as { authMode?: string } | null)?.authMode ===
    "subscription";
  return connections
    .filter((c) => c.status === "connected")
    .sort((a, b) => Number(isSub(b)) - Number(isSub(a)));
}

/** The model a new agent uses on a connection: its harness default first, as
 * the web create form chooses. */
export function defaultModelFor(connection: ApiConnection): string {
  const models = catalog(connection);
  return models.find((m) => isDefaultId(m.id))?.id || models[0]?.id || "";
}

/** A run's recorded model for a card tag. An unresolved harness default has
 * nothing useful to show, so it is left blank. */
export function runModelLabel(id: string | null | undefined): string {
  if (!id || isDefaultId(id)) return "";
  return modelIdLabel(id);
}
