import { useState } from "react";
import type { Agent } from "../shared/types";
import { api } from "./api";
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
                await api<Agent>(
                  `/agents/${agent.id}`,
                  { retired: !retired },
                  "PATCH",
                  AbortSignal.timeout(15000),
                ),
              );
            } catch (e) {
              setError(
                (e as Error).name === "TimeoutError"
                  ? "Loop took too long to respond. Try again."
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
