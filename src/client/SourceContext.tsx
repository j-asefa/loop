import {
  boundSourceCapabilities,
  fleetOperationReason,
} from "./fleetCapabilities";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ReadMode } from "./read-executor";
import { capabilities as shellCapabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";
import { useCollectionRead } from "./CollectionRead";
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

export function useProjectionRoute({
  source: providedSource,
  key = "",
}: { source?: string; key?: string } = {}) {
  const contextSource = useSourceId();
  const source = providedSource ?? contextSource;
  const { request } = useCollectionRead(JSON.stringify([source, key]));
  return useMemo(
    () =>
      <C extends RouteContract & { method: "GET" }>(
        contract: C,
        input: RouteInput<C>,
        {
          source: destination = source,
          mode = "automatic",
          signal,
          onRetry,
        }: {
          source?: string;
          mode?: ReadMode;
          signal?: AbortSignal;
          onRetry?: (error: unknown) => void;
        } = {},
      ) =>
        request(
          (ownedSignal, actualMode) =>
            readRoute(
              contract,
              input,
              destination,
              ownedSignal,
              onRetry,
              actualMode,
            ),
          { signal, mode },
        ),
    [source, request],
  );
}
