import { useSyncExternalStore } from "react";

// Written by the workspace event socket; read wherever the reader is looking.
// Sheets are modal (top layer), so the page alone could not show this.
type Connection = { reconnecting: boolean; updated: boolean };
let state: Connection = { reconnecting: false, updated: false };
const listeners = new Set<() => void>();
export function setConnection(next: Partial<Connection>) {
  if (
    Object.entries(next).every(([k, v]) => state[k as keyof Connection] === v)
  )
    return;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Loop restarting or updated: shown on the page and inside open sheets. */
export function ConnectionNotice() {
  const { reconnecting, updated } = useSyncExternalStore(
    subscribe,
    () => state,
  );
  if (!reconnecting && !updated) return null;
  return (
    <p className="connection-notice" role="status">
      {reconnecting
        ? "Loop is reconnecting… Work continues."
        : "This page and the running app use different builds."}
      {updated && !reconnecting && (
        // Never automatic: the reader chooses when, and drafts are kept.
        <button className="text-button" onClick={() => location.reload()}>
          Reload to update
        </button>
      )}
    </p>
  );
}
