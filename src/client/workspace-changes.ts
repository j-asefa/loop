import {
  invalidate,
  eventScopes,
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

export function broadWorkspaceChange(event: Event) {
  const detail = (event as CustomEvent<WorkspaceChangeDetail>).detail;
  return (
    !detail?.changes ||
    detail.changes.some((change) =>
      change.events.some((event) =>
        eventScopes(event).some(
          (scope) => scope.kind === "collection" && scope.id === "all",
        ),
      ),
    )
  );
}

/** Complete producers name collection dependencies explicitly. Streamed
 * display rows go straight to their reducer instead of refreshing every view. */
function reconciliationScopes(
  event: WorkspaceEvent,
  capabilities?: WorkspaceCapabilities,
) {
  if (capabilities?.transcript !== "delta") return eventScopes(event);
  if (event.type === "provider.receipt" || event.type === "native.usage")
    return [{ kind: "collection" as const, id: "usage" as const }];
  if (event.type === "activity.updated" || event.type === "trace.updated")
    return [{ kind: "collection" as const, id: "activities" as const }];
  if (event.type === "connection.status")
    return [{ kind: "collection" as const, id: "metadata" as const }];
  if (event.type.startsWith("message.") || event.type === "native.event")
    return [];
  // PR 6's transactional producer inventory covers run, conversation and
  // subject changes. Those identities alone are not broad invalidations.
  return eventScopes(event)
    .filter((scope) => scope.kind === "collection")
    .flatMap((scope) =>
      scope.id === "social"
        ? [scope, { kind: "collection" as const, id: "feed" as const }]
        : scope.id === "runs"
          ? [scope, { kind: "collection" as const, id: "usage" as const }]
          : [scope],
    );
}

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
      for (const scope of reconciliationScopes(
        event,
        this.capabilities.get(source),
      ))
        scopes.set(JSON.stringify(scope), invalidate(scope));
    if (scopes.size > 256) {
      scopes.clear();
      scopes.set("all", invalidate());
    }
    if (scopes.size) this.pending.set(source, scopes);
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
      change.events.some((event) =>
        eventScopes(event).some((scope) => {
          if (scope.kind === "collection")
            return scope.id === "all" || scope.id === surface;
          if (scope.kind === "conversation" && conversation)
            return scope.id === conversation;
          // Run events do not contain authoritative projection rows or a complete
          // dependency map yet. Preserve their broad reconciliation semantics.
          return true;
        }),
      ),
  );
}
