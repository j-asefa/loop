import { listenClientEvent, type ClientEvents } from "./clientEvents";
import {
  invalidate,
  eventScopes,
  reconciliationScopes,
  type WorkspaceCollection,
  type WorkspaceEvent,
  type WorkspaceCapabilities,
} from "../shared/workspace-events";

type WorkspaceChangeDetail = NonNullable<ClientEvents["loop-workspace-change"]>;
type WorkspaceSurface = WorkspaceCollection | "thread" | "metadata";

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

export function listenWorkspaceChanges(
  surface: WorkspaceSurface,
  changed: (event: Event) => void,
  source?: string,
  conversation?: string,
) {
  return listenClientEvent("loop-workspace-change", (_detail, event) => {
    if (workspaceChangeAffects(event, surface, source, conversation))
      changed(event);
  });
}

/** Coalescing retains scopes per source without holding streamed payloads. */
export class WorkspaceChangeQueue {
  private pending = new Map<string, Map<string, WorkspaceEvent>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastRefresh = 0;
  private scheduledAt = 0;
  private publish: ((detail: WorkspaceChangeDetail) => void) | undefined;
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
    if (!this.size) this.cancel();
    else if (this.publish) this.schedule(this.publish);
  }
  clear() {
    this.cancel();
    this.pending.clear();
    this.capabilities.clear();
  }
  private cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.publish = undefined;
  }
  schedule(publish: (detail: WorkspaceChangeDetail) => void) {
    if (!this.size) return;
    const due = this.lastRefresh + (this.broad ? 3000 : 2000);
    if (this.timer !== undefined && this.scheduledAt === due) return;
    // A broad invalidation may arrive after a scoped timer was scheduled.
    // Move that deadline once, without postponing it on every later event.
    this.cancel();
    this.publish = publish;
    this.scheduledAt = due;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.lastRefresh = Date.now();
        publish(this.drain());
      },
      Math.max(0, due - Date.now()),
    );
  }
  get size() {
    return this.pending.size;
  }
  get broad() {
    return [...this.pending.values()].some((events) =>
      [...events.values()].some(
        (event) =>
          event.scope.kind === "collection" && event.scope.id === "all",
      ),
    );
  }
  drain(): WorkspaceChangeDetail {
    this.cancel();
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
