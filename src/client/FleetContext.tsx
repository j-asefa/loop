import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readRoute } from "./workspace-api";
import { fleetAdminApi, type FleetAdminState } from "../shared/fleet-admin-api";
import type { z } from "zod";

export type FleetState = z.infer<typeof FleetAdminState>;
type FleetContextValue = {
  state: FleetState | null;
  error: string;
  checkedAt: number;
  refresh: () => Promise<void>;
};
const Context = createContext<FleetContextValue>({
  state: null,
  error: "",
  checkedAt: 0,
  refresh: async () => {},
});
export const useFleet = () => useContext(Context);
/** The gateway runs the fleet extension: its admin state answered, or failed
 * for a reason other than being absent (404 without --fleet). */
export function useFleetAvailable() {
  const { state, error } = useFleet();
  return state !== null || error !== "";
}
export function WhenFleetAvailable({ children }: { children: ReactNode }) {
  return useFleetAvailable() ? <>{children}</> : null;
}

/** This state always belongs to the browser's gateway, independent of the
 * source of the selected conversation. It never persists capabilities or keys. */
export function FleetProvider({
  owner,
  children,
}: {
  owner: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<FleetState | null>(null);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const active = useRef(false),
    generation = useRef(0);
  const latest = useRef<FleetState | null>(null),
    lastStarted = useRef(0),
    unavailable = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!active.current) return;
    lastStarted.current = Date.now();
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await readRoute(
        fleetAdminApi.state,
        {},
        "",
        controller.signal,
      );
      if (!active.current || current !== generation.current) return;
      latest.current = value;
      unavailable.current = false;
      setState(value);
      setError("");
      setCheckedAt(Date.now());
    } catch (error) {
      if (
        !active.current ||
        current !== generation.current ||
        controller.signal.aborted
      )
        return;
      const status = (error as { status?: number }).status;
      unavailable.current = status !== 404;
      if (status === 404) {
        latest.current = null;
        setState(null);
        setError("");
      } else {
        // Keep the last roster as stale, but disable directory edits until a
        // current authority read succeeds. A transport failure is not removal.
        setError(
          "Directory status is unavailable. Refresh before making changes.",
        );
      }
    }
  }, []);
  useEffect(() => {
    active.current = true;
    latest.current = null;
    unavailable.current = false;
    setState(null);
    setError("");
    setCheckedAt(0);
    const foreground = () => {
      if (!document.hidden) void refresh();
    };
    const reconnect = () => {
      if (!document.hidden) void refresh();
    };
    const changed = () => {
      if (!document.hidden && Date.now() - lastStarted.current >= 30_000)
        void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("online", reconnect);
    window.addEventListener("loop-workspace-change", changed);
    // Authority is not part of older gateways' workspace event projections.
    // One shared visible-page check catches handoff in another browser tab
    // and recovers an exhausted first read. Unsupported (404) and healthy
    // standalone gateways do not acquire an idle polling loop.
    const timer = setInterval(() => {
      if (
        unavailable.current ||
        (latest.current && latest.current.state !== "standalone")
      )
        changed();
    }, 30_000);
    return () => {
      active.current = false;
      generation.current++;
      request.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("loop-workspace-change", changed);
    };
  }, [owner, refresh]);
  return (
    <Context.Provider value={{ state, error, checkedAt, refresh }}>
      {children}
    </Context.Provider>
  );
}

export function fleetAuthorityLabel(state: FleetState) {
  if (state.state === "controller")
    return "This session controls the directory";
  if (state.state === "replica") {
    const controller = state.directory?.document.members.find(
      (m) => m.machineId === state.directory?.document.controller.machineId,
    );
    return `Read-only directory replica — controlled by ${controller?.name ?? "another machine"}`;
  }
  return "Awaiting re-pair/recovery";
}

export function FleetAuthorityNotice({ open }: { open: () => void }) {
  const { state, error } = useFleet();
  if (!error && (!state || state.state === "standalone")) return null;
  return (
    <button type="button" className="fleet-authority-notice" onClick={open}>
      <span>
        {error
          ? "Directory status unavailable"
          : state && fleetAuthorityLabel(state)}
      </span>
      {!!state && state.pendingDistribution > 0 && (
        <small>Directory synchronization pending</small>
      )}
    </button>
  );
}
