// The shell keeps its original source while a thread opens on another source.
// Read the address separately for navigation; async work must not derive its
// destination from a URL that can change underneath it.
let shellSource: string | undefined;
export function setShellSource(source: string) {
  shellSource = source;
}
// History state belongs to this document/navigation entry and survives reload.
// A fresh deep link has no saved shell and still opens over the local Feed.
export function initializeShellSource() {
  const saved = history.state?.loopShellSource;
  const source =
    typeof saved === "string" &&
    (saved === "" ||
      routeSourceId("?source=" + encodeURIComponent(saved)) === saved)
      ? saved
      : new URLSearchParams(location.search).has("conversation")
        ? ""
        : routeSourceId();
  setShellSource(source);
  history.replaceState(
    { ...history.state, loopShellSource: source, loopSheet: false },
    "",
  );
}
export function executionSourceId() {
  return shellSource ?? routeSourceId();
}
export function routeSourceId(
  search = typeof location === "undefined" ? "" : location.search,
) {
  const params = new URLSearchParams(search);
  // Existing paired links used `workspace=docker:<id>`.
  const value = params.get("source") || params.get("workspace") || "";
  return /^[a-z][a-z0-9-]{0,31}:[a-zA-Z0-9._~-]{1,128}$/.test(value)
    ? value
    : "";
}

export type SourceApiPath<P extends string> =
  | P
  | (P extends `/api/${infer Rest}`
      ? `/api/agent-sources/${string}/${Rest}`
      : never);
export function sourceApiPath<const P extends string>(
  path: P,
): SourceApiPath<P>;
export function sourceApiPath(path: string) {
  return sourceApiPathAt(path, executionSourceId());
}

export function sourceApiPathAt<const P extends string>(
  path: P,
  id: string,
): SourceApiPath<P>;
export function sourceApiPathAt(path: string, id: string) {
  // Social feeds belong to the paired app, so they remain available when an
  // older linked Docker server has no Social routes.
  return id &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/agent-sources/") &&
    !/^\/api\/social(?:[/?]|$)/.test(path)
    ? `/api/agent-sources/${encodeURIComponent(id)}/` + path.slice(5)
    : path;
}

// The source query is an internal route to the owner of a thread or agent.
// It is not a workspace-wide choice in the UI.
export function sourceUrl(
  id: string,
  target: {
    conversation?: string;
    message?: string;
    agent?: string;
    artifact?: string;
  } = {},
) {
  const url = new URL(location.href);
  url.search = "";
  if (id) url.searchParams.set("source", id);
  if (target.conversation)
    url.searchParams.set("conversation", target.conversation);
  if (target.message) url.searchParams.set("message", target.message);
  if (target.agent) url.searchParams.set("agent", target.agent);
  if (target.artifact) url.searchParams.set("artifact", target.artifact);
  return url.pathname + url.search;
}

export function returnToLocalSource() {
  const url = new URL(location.href);
  url.search = "";
  location.assign(url.pathname + url.search);
}
