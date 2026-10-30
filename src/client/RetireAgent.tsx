import { workspaceApi } from "../shared/workspace-api";
import { useSourceRoute } from "./SourceContext";
import { useState } from "react";
import type { Agent } from "../shared/types";

import { Sheet } from "./components";

export function RetireAgent({
  agent,
  onClose,
  onChanged,
}: {
  agent: Agent;
  onClose: () => void;
  onChanged: (agent: Agent) => void;
}) {
  const route = useSourceRoute();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const retired = !!agent.retired_at;
  return (
    <Sheet
      title={`${retired ? "Restore" : "Retire"} @${agent.name}?`}
      onClose={onClose}
    >
      <p>
        {retired
          ? "This agent will appear in your active agents and can accept new messages again."
          : "This removes the agent from your active agents and stops new work being assigned. Accepted work can finish. Conversations, results and saved cards stay available, and you can restore the agent any time."}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              onChanged(
                await route(
                  workspaceApi.agentUpdate,
                  { params: { id: agent.id }, body: { retired: !retired } },
                  AbortSignal.timeout(15000),
                ),
              );
            } catch (e) {
              setError(
                (e as Error).name === "TimeoutError"
                  ? "Loop55 took too long to respond. Try again."
                  : (e as Error).message,
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Updating…" : retired ? "Restore agent" : "Retire agent"}
        </button>
      </div>
    </Sheet>
  );
}
