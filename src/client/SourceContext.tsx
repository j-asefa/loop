import { createContext, useContext, useMemo, type ReactNode } from "react";
import { apiInWorkspace, readInWorkspace, type api } from "./api";
import { capabilities as shellCapabilities } from "./capabilities";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";

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
    () => (path: string) => sourceApiPathAt(path, source),
    [source],
  );
}

export function useSourceRead() {
  const source = useSourceId();
  return useMemo(() => <T = any,>(path: string, signal: AbortSignal) =>
    readInWorkspace<T>(path, source, signal), [source]);
}
