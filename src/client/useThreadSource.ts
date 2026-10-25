import { workspaceApi, type Bootstrap } from "../shared/workspace-api";
import { callRoute } from "./workspace-api";
import { useEffect, useState } from "react";
import { apiInWorkspace, retryAfter, isRateLimited, RATE_LIMITED } from "./api";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { executionSourceId } from "./sourceRouting";
import type { Capabilities } from "../shared/capabilities";

type Snapshot = Bootstrap;

// Keep the Feed's source and identity untouched. Only the open thread needs
// this source's agent settings, project choices and runtime capabilities.
export function useThreadSource(source: string | null, owner?: string) {
  const [revision, setRevision] = useState(0);
  type State = {
    key: string;
    data?: Snapshot;
    capabilities?: Capabilities;
    error?: string;
    rateLimited?: boolean;
  };
  const [state, setState] = useState<State>();
  const key = JSON.stringify([source, owner]);
  const cacheKey = "thread-source:" + key;
  const cached = () => owner === viewOwner() ? cachedView<State>(cacheKey) : undefined;
  useEffect(() => {
    if (source === null || source === executionSourceId() || !owner) return;
    let active = true;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      controller = new AbortController();
      // Older mobile WebKit has AbortController but no AbortSignal.any.
      timeout = setTimeout(() => controller?.abort(), 20_000);
      const signal = controller.signal;
      try {
        const [data, capabilities] = await Promise.all([
          callRoute(workspaceApi.bootstrap, {}, source, signal),
          apiInWorkspace<Capabilities>("/capabilities", source, undefined, undefined, signal),
        ]);
        if (!active || owner !== viewOwner()) return;
        const fresh = { key, data, capabilities };
        cacheView(cacheKey, fresh, owner);
        setState(fresh);
      } catch (error) {
        controller.abort(); // Cancel the sibling read when Promise.all rejects.
        if (!active || owner !== viewOwner()) return;
        const rateLimited = isRateLimited(error);
        setState(previous => ({
          ...(previous?.key === key ? previous : cached()), key, rateLimited,
          error: rateLimited ? RATE_LIMITED : (error as Error).message || "This workspace is unavailable. Try again.",
        }));
        if (rateLimited)
          retry = setTimeout(() => void load(), Math.min(2_147_483_647, retryAfter(error)));
      } finally { clearTimeout(timeout); }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timeout);
      clearTimeout(retry);
      controller?.abort();
    };
  }, [key, revision]);
  return {
    ...(state?.key === key ? state : cached() ?? {}),
    retry: () => setRevision((value) => value + 1),
  };
}
