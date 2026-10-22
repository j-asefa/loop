import { ArrowUpRight } from "lucide-react";
import type { Run } from "../shared/types";

const labels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  awaiting_approval: "Needs approval",
  waiting_children: "Waiting for agents",
};

export function currentAgentWork(runs: Run[], agentId?: string) {
  return runs
    .filter((run) => run.agent_id === agentId && labels[run.state])
    .sort(
      (a, b) =>
        Number(a.state === "queued") - Number(b.state === "queued") ||
        a.created_at - b.created_at,
    );
}

export function AgentWork({
  runs,
  onConversation,
}: {
  runs: Run[];
  onConversation: (id: string) => void;
}) {
  if (!runs.length) return <p className="field-hint">No active tasks.</p>;
  const runningChats = new Set(
    runs
      .filter((run) => run.state === "running" && run.conversation_id)
      .map((run) => run.conversation_id),
  ).size;
  const summary = Object.entries(labels)
    .flatMap(([state, label]) => {
      const count = runs.filter((run) => run.state === state).length;
      return count ? [`${count} ${label.toLowerCase()}`] : [];
    })
    .join(" · ");
  const task = (run: Run) => (
    <li key={run.id} data-state={run.state}>
      <button
        onClick={() =>
          run.conversation_id && onConversation(run.conversation_id)
        }
        disabled={!run.conversation_id}
      >
        <span>
          <small>{labels[run.state]}</small>
          <strong>{run.input}</strong>
        </span>
        <ArrowUpRight size={18} aria-hidden="true" />
      </button>
    </li>
  );
  return (
    <section className="agent-work" aria-label="Current work">
      <header>
        <h2>Current work</h2>
        <span role="status">{summary}</span>
      </header>
      {runningChats > 1 && (
        <p className="field-hint" role="status">
          These chats share the same project folder. Changes made in one chat
          can affect the others.
        </p>
      )}
      <ul>{runs.slice(0, 3).map(task)}</ul>
      {runs.length > 3 && (
        <details>
          <summary>{runs.length - 3} more tasks</summary>
          <ul>{runs.slice(3).map(task)}</ul>
        </details>
      )}
    </section>
  );
}
