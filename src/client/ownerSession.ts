type OwnerState = Readonly<{ owner: string | undefined; generation: number }>;

let state: OwnerState = { owner: undefined, generation: 0 };
const caches = new Set<() => void>();

export const ownerSession = {
  get current(): OwnerState {
    return state;
  },
  change(next: string | undefined) {
    const owner = next || undefined;
    if (owner === state.owner) return;
    state = { owner, generation: state.generation + 1 };
    for (const clear of caches) clear();
  },
  // Register module-lifetime caches only. Per-view readers have their own disposal.
  registerCache(clear: () => void) {
    caches.add(clear);
  },
};
