import { useEffect, useState } from "react";
import { apiInWorkspace } from "./api";
import { executionSourceId } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";
import type { Agent, Connection, Folder, Team } from "../shared/types";

type Snapshot = {
  agents: Agent[];
  connections: Connection[];
  folders: Folder[];
  teams?: Team[];
};

// Keep the Feed's source and identity untouched. Only the open thread needs
// this source's agent settings, project choices and runtime capabilities.
export function useThreadSource(source: string | null, owner?: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: Snapshot;
    capabilities?: Capabilities;
    error?: string;
  }>();
  const key = JSON.stringify([source, owner]);
  useEffect(() => {
    if (source === null || source === executionSourceId() || !owner) return;
    const controller = new AbortController();
    let active = true;
    // Older mobile WebKit has AbortController but no AbortSignal.any.
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const signal = controller.signal;
    void Promise.all([
      apiInWorkspace<Snapshot>(
        "/bootstrap",
        source,
        undefined,
        undefined,
        signal,
      ),
      apiInWorkspace<Capabilities>(
        "/capabilities",
        source,
        undefined,
        undefined,
        signal,
      ),
    ])
      .then(([data, capabilities]) => {
        if (active) setState({ key, data, capabilities });
      })
      .catch((error) => {
        if (active)
          setState({
            key,
            error: error.message || "This workspace is unavailable. Try again.",
          });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      active = false;
      controller.abort();
    };
  }, [key, revision]);
  return {
    ...(state?.key === key ? state : {}),
    retry: () => setRevision((value) => value + 1),
  };
}
