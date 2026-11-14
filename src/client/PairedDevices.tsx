import { useState } from "react";
import { callRoute } from "./api";
import { executionSourceId } from "./sourceRouting";
import { workspaceApi } from "../shared/workspace-api";
import { useProjectionQuery, CollectionReadNotice } from "./CollectionRead";
import { Sheet } from "./components";
import { MAX_CONCURRENT_RUNS } from "../shared/concurrency.js";
export function PairedDevices({ onClose }: { onClose: () => void }) {
  const source = executionSourceId();
  const workspaceRead = useProjectionQuery(
    workspaceApi.workspace,
    {},
    { source, collections: ["metadata", "runs"] },
  );
  const devicesRead = useProjectionQuery(
    workspaceApi.workspaceDevices,
    {},
    { source, collections: ["metadata"] },
  );
  const workspace = workspaceRead.data,
    devices = devicesRead.data ?? [];
  const [error, setError] = useState("");
  async function load() {
    await Promise.all([workspaceRead.refresh(true), devicesRead.refresh(true)]);
  }
  return (
    <Sheet title="This computer & paired devices" onClose={onClose}>
      <CollectionReadNotice
        error={workspaceRead.error && "Computer status: " + workspaceRead.error}
        busy={workspaceRead.busy}
        retry={() => void workspaceRead.refresh(true)}
      />
      <CollectionReadNotice
        error={devicesRead.error && "Paired devices: " + devicesRead.error}
        busy={devicesRead.busy}
        retry={() => void devicesRead.refresh(true)}
      />
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
                  source,
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
