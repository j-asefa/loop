import { useEffect, useState } from "react";
import { callRoute } from "./workspace-api";
import { executionSourceId } from "./sourceRouting";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useProjectionRoute } from "./SourceContext";
import { Sheet } from "./components";
import { MAX_CONCURRENT_RUNS } from "../../runtime/concurrency.ts";
export function PairedDevices({ onClose }: { onClose: () => void }) {
  const read = useProjectionRoute();
  const [workspace, setWorkspace] =
      useState<RouteResponse<typeof workspaceApi.workspace>>(),
    [devices, setDevices] = useState<
      RouteResponse<typeof workspaceApi.workspaceDevices>
    >([]),
    [error, setError] = useState("");
  async function load() {
    const [w, d] = await Promise.all([
      read(workspaceApi.workspace, {}),
      callRoute(workspaceApi.workspaceDevices, {}, executionSourceId()),
    ]);
    setWorkspace(w);
    setDevices(d);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <Sheet title="This computer & paired devices" onClose={onClose}>
      <p>
        All projects and native harnesses run on this computer. Loop keeps
        running in the background until <code>loop stop</code>; your phone can
        disconnect while work continues.
      </p>
      <p className="muted">
        {workspace?.nativeProcesses || 0} native processes · up to{" "}
        {workspace?.concurrency ?? MAX_CONCURRENT_RUNS} active tasks
      </p>
      <p>
        Run <code>loop pair</code> to authorize another device. When the Quick
        Tunnel address changes, run it again and scan the code from the Loop app
        to reconnect. Cloudflare terminates TLS.
      </p>
      {devices.map((d) => (
        <div className="connection-card" key={d.id}>
          <strong>{d.name}</strong>
          <p>Expires {new Date(d.expires).toLocaleString()}</p>
          <button
            onClick={async () => {
              try {
                await callRoute(
                  workspaceApi.workspaceRevoke,
                  { body: { id: d.id } },
                  executionSourceId(),
                );
                await load();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Revoke device
          </button>
        </div>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
