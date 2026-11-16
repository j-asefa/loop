import { useEffect, useRef, useState, type RefObject } from "react";
import { emitClientEvent } from "./clientEvents";
import { readRoute, clearAuthorization } from "./api";
import { workspaceApi } from "../shared/workspace-api";
import { ConnectionNotice, setConnection } from "./ConnectionNotice";
import { watchWorkspaceEvents } from "./workspace-events";
import { publishProjectionFrame } from "./workspace-projections";
import { WorkspaceChangeQueue } from "./workspace-changes";
import type { WorkspaceEvent } from "../shared/workspace-events";
import { capabilities } from "./capabilities";
import { multiplexWorkspaceSocket } from "./workspace-multiplex";
import { executionSourceId, sourceApiPathAt } from "./sourceRouting";
import {
  BuildIdentity,
  browserNeedsReload,
  runningBuild,
} from "../shared/build";

function updateBrowserBuild(value: unknown) {
  const identity = BuildIdentity.safeParse(value);
  if (!identity.success) return;
  const updated = browserNeedsReload(runningBuild, identity.data);
  if (updated !== null) setConnection({ updated });
}

export function WorkspaceConnection({
  owner,
  sources,
  stopRef,
}: {
  owner: string;
  sources: { id: string }[];
  stopRef: RefObject<() => void>;
}) {
  const [status, setStatus] = useState("Connecting to workspace…");
  const sourceKey = JSON.stringify(
    [...new Set(["", executionSourceId(), ...sources.map((s) => s.id)])].sort(),
  );
  const reconcileSources = useRef<(sources: string[]) => void>(() => {});
  // Subscription lifetime and build identity belong to the signed-in owner.
  // Discovery changes are reconciled below without restarting healthy peers.
  useEffect(() => {
    const pending = new WorkspaceChangeQueue();
    // Streaming tokens can produce many committed events. Reconcile views
    // immediately after idle. Broad invalidations refresh every collection:
    // allow three seconds between them so two tabs leave room under the owner
    // request limit. Scoped changes retain two seconds; projected rows publish
    // directly below. Retain every source and the trailing change.
    const changed = (source: string, events?: readonly WorkspaceEvent[]) => {
      pending.add(source, events);
      pending.schedule((detail) => {
        emitClientEvent("loop-workspace-change", detail);
      });
    };
    const stops = new Map<string, () => void>();
    const subscribe = (sourceId: string) => {
      const path =
        !sourceId && (capabilities.pairedDevices || executionSourceId())
          ? "/ws"
          : sourceApiPathAt("/api/events/ws", sourceId);
      const url = new URL(path, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return watchWorkspaceEvents({
        url,
        source: sourceId,
        socket: (url: URL) => multiplexWorkspaceSocket(url, sourceId),
        read: (after, signal) =>
          readRoute(
            workspaceApi.events,
            { query: { after } },
            sourceId,
            signal,
          ),
        changed: (events) => changed(sourceId, events),
        frame: (m) => {
          publishProjectionFrame(sourceId, m);
          if (m.capabilities)
            pending.capabilities.set(sourceId, m.capabilities);
          if (m.type !== "reset") return;
          if (sourceId) return;
          updateBrowserBuild(m.buildIdentity);
        },
        ...(!sourceId
          ? {
              connected: (connected: boolean) => {
                setStatus(
                  connected
                    ? "Connected to workspace"
                    : "Loop is reconnecting… Work continues.",
                );
                setConnection({ reconnecting: !connected });
              },
              expired: () => {
                clearAuthorization();
                emitClientEvent("loop-auth-expired");
              },
            }
          : {}),
      });
    };
    const reconcile = (sources: string[]) => {
      const wanted = new Set(sources);
      for (const [source, stop] of stops) {
        if (wanted.has(source)) continue;
        stop();
        stops.delete(source);
        pending.delete(source);
      }
      for (const source of wanted)
        if (!stops.has(source)) stops.set(source, subscribe(source));
    };
    reconcileSources.current = reconcile;
    const stop = () => {
      stops.forEach((stop) => stop());
      stops.clear();
      pending.clear();
      if (reconcileSources.current === reconcile)
        reconcileSources.current = () => {};
    };
    stopRef.current = stop;
    return () => {
      stop();
      if (stopRef.current === stop) stopRef.current = () => {};
    };
  }, [owner]);
  useEffect(() => {
    reconcileSources.current(JSON.parse(sourceKey));
  }, [owner, sourceKey]);
  return (
    <p className="workspace-connection" role="status">
      {status}
    </p>
  );
}
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
        if (!stopped && generation === request)
          updateBrowserBuild(response.serving);
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
