// The current owner and generation, with the paired-session projection. A
// session read publishes only while the snapshot that started it is current,
// so a late response cannot replace an expired session, another owner or a
// newer identity. Cache resets finish before subscribers observe an owner
// change. Re-selecting the same owner keeps the generation and caches; signing
// out or selecting another owner advances it before clearing registered
// caches. Clearing a cache does not authorize an old callback: late responses
// still check their originating generation. Owner changes never delete
// persisted drafts or command identities.
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
