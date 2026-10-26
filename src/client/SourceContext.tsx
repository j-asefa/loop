import type { LegacyClientPath } from "./legacy-paths";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { apiInWorkspace, readInWorkspace, type api } from "./api";
import { capabilities as shellCapabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";
import { viewGeneration } from "./viewCache";
import { callRoute, readRoute } from "./workspace-api";
import type { RouteContract, RouteInput } from "../shared/workspace-api";

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
    () => ({ sourceId, capabilities }),
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
// Each render's callback captures an immutable destination, including after
// awaits and in Undo callbacks that outlive the originating conversation.
export function useSourceApi() {
  const source = useSourceId();
  return useMemo(
    () =>
      ((path, body, method, signal) =>
        apiInWorkspace(path, source, body, method, signal)) as typeof api,
    [source],
  );
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

export function useSourceRead() {
  const source = useSourceId();
  return useMemo(
    () =>
      <T = any,>(
        path: LegacyClientPath,
        signal: AbortSignal,
        onRetry?: (error: unknown) => void,
      ) =>
        readInWorkspace<T>(path, source, signal, onRetry),
    [source],
  );
}

export function useSourceRoute() {
  const source = useSourceId();
  return useMemo(
    () =>
      <C extends RouteContract>(
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
export function useProjectionRead(sourceId?: string) {
  const handle = useProjectionScope(sourceId);
  return useMemo(
    () =>
      <T = any,>(path: LegacyClientPath, source = handle.source) =>
        readInWorkspace<T>(path, source, handle.controller.signal),
    [handle],
  );
}
export function useProjectionRoute(sourceId?: string) {
  const handle = useProjectionScope(sourceId);
  return useMemo(
    () =>
      <C extends RouteContract & { method: "GET" }>(
        contract: C,
        input: RouteInput<C>,
        source = handle.source,
      ) =>
        readRoute(contract, input, source, handle.controller.signal),
    [handle],
  );
}
