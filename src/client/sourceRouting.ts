export function executionSourceId() {
  const params = new URLSearchParams(location.search);
  // Existing paired links used `workspace=docker:<id>`.
  const value = params.get("source") || params.get("workspace") || "";
  return /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128}$/.test(value)
    ? value
    : "";
}

export function sourceApiPath(path: string) {
  return sourceApiPathAt(path, executionSourceId());
}

export function sourceApiPathAt(path: string, id: string) {
  // Social feeds belong to the paired app, so they remain available when an
  // older linked Docker server has no Social routes.
  return id &&
    path.startsWith("/api/") &&
    !/^\/api\/social(?:[/?]|$)/.test(path)
    ? `/api/agent-sources/${encodeURIComponent(id)}/` + path.slice(5)
    : path;
}

// The source query is an internal route to the owner of a thread or agent.
// It is not a workspace-wide choice in the UI.
export function sourceUrl(
  id: string,
  target: { conversation?: string; message?: string; agent?: string } = {},
) {
  const url = new URL(location.href);
  url.search = "";
  if (id) url.searchParams.set("source", id);
  if (target.conversation)
    url.searchParams.set("conversation", target.conversation);
  if (target.message) url.searchParams.set("message", target.message);
  if (target.agent) url.searchParams.set("agent", target.agent);
  return url.pathname + url.search;
}

export function returnToLocalSource() {
  const url = new URL(location.href);
  url.search = "";
  location.assign(url.pathname + url.search);
}
