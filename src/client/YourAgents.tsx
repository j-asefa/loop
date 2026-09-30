import { Plus } from "lucide-react";
import type { Agent, Connection, Run } from "../shared/types";
import { Avatar } from "./components";
import { agentModelName } from "./modelChoices";

const WORKING_STATES = ["running", "pausing", "waiting_children"];

// Agents with a run currently in a working state lead the strip, most
// recently launched first, so the agent someone just kicked off is the
// one they see without scrolling.
function orderByActivity(agents: Agent[], runs: Run[]): Agent[] {
  return agents
    .map((agent, index) => {
      const launchedAt = runs.reduce<number | null>(
        (latest, run) =>
          run.agent_id === agent.id && WORKING_STATES.includes(run.state)
            ? Math.max(latest ?? -Infinity, run.created_at)
            : latest,
        null,
      );
      return { agent, index, launchedAt };
    })
    .sort((a, b) => {
      if (a.launchedAt !== null && b.launchedAt !== null) {
        return b.launchedAt - a.launchedAt;
      }
      if (a.launchedAt !== null) return -1;
      if (b.launchedAt !== null) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.agent);
}

export function YourAgents({
  agents,
  connections,
  runs,
  onProfile,
  onCreate,
}: {
  agents: Agent[];
  connections: Connection[];
  runs: Run[];
  onProfile: (agent: Agent) => void;
  onCreate: () => void;
}) {
  return (
    <section className="your-agents" aria-label="Your agents">
      <header>
        <h2>Your agents</h2>
      </header>
      <div className="agent-strip">
        <button
          className="new-agent-shortcut"
          onClick={onCreate}
          aria-label="New agent"
        >
          <span className="agent-shortcut-model" aria-hidden="true" />
          <span className="agent-portrait">
            <Plus size={27} />
          </span>
          <span className="agent-shortcut-name">New agent</span>
          <span className="agent-shortcut-status">Create</span>
        </button>
        {orderByActivity(agents, runs).map((agent) => {
          const model = agentModelName(agent, connections);
          const activity = runs.filter((run) => run.agent_id === agent.id);
          const status = activity.some((run) =>
            ["failed", "interrupted", "awaiting_approval", "paused"].includes(
              run.state,
            ),
          )
            ? "Needs you"
            : activity.some((run) => WORKING_STATES.includes(run.state))
              ? "Working"
              : activity.some((run) => run.state === "queued")
                ? "Queued"
                : "Ready";
          return (
            <button
              key={agent.id}
              onClick={() => onProfile(agent)}
              title={`@${agent.name} · ${model}`}
              aria-label={`@${agent.name} · ${model} · ${status}`}
            >
              <span className="agent-shortcut-model" title={model}>
                {model.replace(/^Claude /, "")}
              </span>
              <span className="agent-portrait">
                <Avatar name={agent.name} provider={agent.provider} />
                <span
                  className="agent-status-dot"
                  data-status={status}
                  aria-hidden="true"
                />
              </span>
              <span className="agent-shortcut-name">@{agent.name}</span>
              <span className="agent-shortcut-status">{status}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
