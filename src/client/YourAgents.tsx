import { Plus } from "lucide-react";
import { Avatar } from "./components";
import { agentModelName } from "./modelChoices";
import type {
  EnvironmentAgent,
  EnvironmentConnection,
  EnvironmentRun,
} from "./agentSources";

const WORKING_STATES = ["running", "pausing", "waiting_children"];

// Agents with a run currently in a working state lead the strip, most
// recently launched first, so the agent someone just kicked off is the
// one they see without scrolling.
function orderByActivity(
  agents: EnvironmentAgent[],
  runs: EnvironmentRun[],
): EnvironmentAgent[] {
  return agents
    .map((agent, index) => {
      const launchedAt = runs.reduce<number | null>(
        (latest, run) =>
          run.agent_id === agent.id &&
          (run.sourceId || "") === (agent.sourceId || "") &&
          WORKING_STATES.includes(run.state)
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
  agents: EnvironmentAgent[];
  connections: EnvironmentConnection[];
  runs: EnvironmentRun[];
  onProfile: (agent: EnvironmentAgent) => void;
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
          const model = agentModelName(
            agent,
            connections.filter(
              (connection) =>
                (connection.sourceId || "") === (agent.sourceId || ""),
            ),
          );
          const activity = runs.filter(
            (run) =>
              run.agent_id === agent.id &&
              (run.sourceId || "") === (agent.sourceId || ""),
          );
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
              key={`${agent.sourceId || "laptop"}:${agent.id}`}
              onClick={() => onProfile(agent)}
              title={`@${agent.name} · ${model} · ${agent.executionEnvironment || "This computer"}`}
              aria-label={`@${agent.name} · ${model} · ${status} · ${agent.executionEnvironment || "This computer"}`}
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
              <span className="agent-shortcut-status" data-status={status}>
                {status}
              </span>
              <span className="agent-shortcut-environment">
                {agent.executionEnvironment || "This computer"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
