import { useEffect } from "react";
import { readRoute } from "./workspace-api";
import { workspaceApi } from "../shared/workspace-api";
import {
  BuildIdentity,
  browserNeedsReload,
  runningBuild,
} from "../shared/build";
import { ConnectionNotice, setConnection } from "./ConnectionNotice";

/** This concerns the origin serving the shell, never a selected linked source. */
export function BrowserBuildStatus() {
  useEffect(() => {
    let stopped = false;
    let request = 0;
    let pending: AbortController | undefined;
    const check = async () => {
      if (stopped || pending) return;
      const generation = ++request;
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await readRoute(
          workspaceApi.build,
          {},
          "",
          controller.signal,
        );
        const serving = BuildIdentity.safeParse(response.serving);
        if (!stopped && generation === request && serving.success) {
          const updated = browserNeedsReload(runningBuild, serving.data);
          if (updated !== null) setConnection({ updated });
        }
      } catch {
        /* A failed read is not evidence that builds match. */
      } finally {
        clearTimeout(timeout);
        controller.abort();
        if (pending === controller) pending = undefined;
      }
    };
    void check();
    const timer = setInterval(check, 15000);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      stopped = true;
      pending?.abort();
      clearInterval(timer);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return <ConnectionNotice />;
}
