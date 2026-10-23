import {
  invalidate,
  type WorkspaceCollection,
  type WorkspaceEvent,
  type WorkspaceCapabilities,
} from "../shared/workspace-events";

export type WorkspaceChange = {
  source: string;
  events: readonly WorkspaceEvent[];
  capabilities?: WorkspaceCapabilities;
};
export type WorkspaceChangeDetail = {
  sources: string[];
  changes?: WorkspaceChange[];
};
export type WorkspaceSurface = WorkspaceCollection | "thread" | "metadata";

export function listenWorkspaceChanges(
  surface: WorkspaceSurface,
  changed: (event: Event) => void,
  source?: string,
  conversation?: string,
) {
  const listener = (event: Event) => {
    if (workspaceChangeAffects(event, surface, source, conversation))
      changed(event);
  };
  window.addEventListener("loop-workspace-change", listener);
  return () => window.removeEventListener("loop-workspace-change", listener);
}

/** Coalescing retains scopes per source without holding streamed payloads. */
export class WorkspaceChangeQueue {
  private pending = new Map<string, Map<string, WorkspaceEvent>>();
  readonly capabilities = new Map<string, WorkspaceCapabilities>();
  add(source: string, events: readonly WorkspaceEvent[] = [invalidate()]) {
    const scopes =
      this.pending.get(source) || new Map<string, WorkspaceEvent>();
    for (const event of events)
      scopes.set(JSON.stringify(event.scope), invalidate(event.scope));
    if (scopes.size > 256) {
      scopes.clear();
      scopes.set("all", invalidate());
    }
    this.pending.set(source, scopes);
  }
  delete(source: string) {
    this.pending.delete(source);
    this.capabilities.delete(source);
  }
  clear() {
    this.pending.clear();
    this.capabilities.clear();
  }
  get size() {
    return this.pending.size;
  }
  drain(): WorkspaceChangeDetail {
    const changes = [...this.pending].map(([source, events]) => ({
      source,
      events: [...events.values()],
      capabilities: this.capabilities.get(source),
    }));
    this.pending.clear();
    return { sources: changes.map((change) => change.source), changes };
  }
}

/** Unscoped action/HTTP notifications retain their existing broad refresh. */
export function workspaceChangeAffects(
  event: Event | undefined,
  surface: WorkspaceSurface,
  source?: string,
  conversation?: string,
) {
  const detail = (event as CustomEvent<WorkspaceChangeDetail> | undefined)
    ?.detail;
  if (
    source !== undefined &&
    detail?.sources &&
    !detail.sources.includes(source)
  )
    return false;
  if (!detail?.changes) return true;
  return detail.changes.some(
    (change) =>
      (source === undefined || change.source === source) &&
      change.events.some(({ scope }) => {
        if (scope.kind === "collection")
          return scope.id === "all" || scope.id === surface;
        if (scope.kind === "conversation" && conversation)
          return scope.id === conversation;
        // Run events do not contain authoritative projection rows or a complete
        // dependency map yet. Preserve their broad reconciliation semantics.
        return true;
      }),
  );
}
