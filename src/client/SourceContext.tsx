import {
  boundSourceCapabilities,
  fleetOperationReason,
} from "./fleetCapabilities";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { ReadMode } from "./api";
import { capabilities as shellCapabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";
import { viewGeneration } from "./viewCache";
import { callRoute, readRoute } from "./api";
import type {
  RouteContract,
  ClientRouteContract,
  RouteInput,
} from "../shared/workspace-api";

const SourceContext = createContext<{
  sourceId: string;
  capabilities: Capabilities;
} | null>(null);
export function SourceProvider({
  sourceId,
  capabilities,
  children,
}: {
  sourceId: string;
  capabilities: Capabilities;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      sourceId,
      capabilities: boundSourceCapabilities(sourceId, capabilities)!,
    }),
    [sourceId, capabilities],
  );
  return (
    <SourceContext.Provider value={value}>{children}</SourceContext.Provider>
  );
}
export function useSourceId() {
  return useContext(SourceContext)?.sourceId ?? executionSourceId();
}
export function useSourceCapabilities() {
  return useContext(SourceContext)?.capabilities ?? shellCapabilities;
}
export function useSourceOperation(contract: RouteContract) {
  return fleetOperationReason(useSourceId(), useSourceCapabilities(), contract);
}
export function useSourcePath() {
  const source = useSourceId();
  return useMemo(
    () =>
      <const P extends string>(path: P) =>
        sourceApiPathAt(path, source),
    [source],
  );
}

// Each callback captures an immutable source, including in late Undo actions.
export function useSourceRoute() {
  const source = useSourceId();
  return useMemo(
    () =>
      <C extends ClientRouteContract>(
        contract: C,
        input: RouteInput<C>,
        signal?: AbortSignal,
      ) =>
        callRoute(contract, input, source, signal),
    [source],
  );
}
export function useSourceRouteRead() {
  const source = useSourceId();
  return useMemo(
    () =>
      <C extends RouteContract & { method: "GET" }>(
        contract: C,
        input: RouteInput<C>,
        signal: AbortSignal,
        onRetry?: (error: unknown) => void,
      ) =>
        readRoute(contract, input, source, signal, onRetry),
    [source],
  );
}

/** Signal-driven snapshots must recover from Retry-After even if no later
 * change arrives. Cancellation belongs to this owner/source view lifetime. */
function useProjectionScope(sourceId?: string) {
  const contextSource = useSourceId(),
    source = sourceId ?? contextSource;
  const generation = viewGeneration();
  const handle = useMemo(
    () => ({ controller: new AbortController(), source }),
    [source, generation],
  );
  useEffect(() => {
    if (handle.controller.signal.aborted)
      handle.controller = new AbortController();
    return () => handle.controller.abort();
  }, [handle]);
  return handle;
}
export function useProjectionRoute(sourceId?: string) {
  const handle = useProjectionScope(sourceId);
  return useMemo(
    () =>
      <C extends RouteContract & { method: "GET" }>(
        contract: C,
        input: RouteInput<C>,
        source = handle.source,
        mode: ReadMode = "automatic",
      ) =>
        readRoute(
          contract,
          input,
          source,
          handle.controller.signal,
          undefined,
          mode,
        ),
    [handle],
  );
}
