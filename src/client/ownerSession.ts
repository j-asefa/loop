import type { RouteResponse, workspaceApi } from "../shared/workspace-api";

export type BrowserSession =
  RouteResponse<typeof workspaceApi.authSession> | undefined;
type OwnerState = Readonly<{
  owner: string | undefined;
  generation: number;
  session: BrowserSession;
}>;

let state: OwnerState = { owner: undefined, generation: 0, session: undefined };
const caches = new Set<() => void>();
const listeners = new Set<() => void>();

function publish(owner: string | undefined, session: BrowserSession) {
  const changed = owner !== state.owner;
  if (!changed && session === state.session) return;
  state = { owner, session, generation: state.generation + Number(changed) };
  if (changed) for (const clear of caches) clear();
  for (const listener of [...listeners]) listener();
}

export const ownerSession = {
  get current(): OwnerState {
    return state;
  },
  change(next: string | undefined) {
    const owner = next || undefined;
    publish(owner, owner === state.owner ? state.session : undefined);
  },
  setSession(session: BrowserSession) {
    publish(session?.user.id || undefined, session);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  // Register module-lifetime caches only. Per-view readers have their own disposal.
  registerCache(clear: () => void) {
    caches.add(clear);
  },
};
