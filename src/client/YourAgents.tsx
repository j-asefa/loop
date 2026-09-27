import { ArrowUpRight, Plus } from "lucide-react";
import type { Agent, Connection, Run } from "../shared/types";
import { Avatar } from "./components";
import { agentModelName } from "./modelChoices";

export function YourAgents({
  agents,
  connections,
  runs,
  onProfile,
  onDirectory,
  onCreate,
}: {
  agents: Agent[];
  connections: Connection[];
  runs: Run[];
  onProfile: (agent: Agent) => void;
  onDirectory: () => void;
  onCreate: () => void;
}) {
  return (
    <section className="your-agents" aria-label="Your agents">
      <header>
        <h2>Your agents</h2>
        <button
          className="text-button agent-directory-trigger"
          onClick={onDirectory}
          aria-label={`All agents (${agents.length})`}
        >
          All agents{" "}
          <span className="agent-directory-count">{agents.length}</span>
          <ArrowUpRight size={17} />
        </button>
      </header>
      <div className="agent-strip">
        {agents.slice(0, 3).map((agent) => {
          const model = agentModelName(agent, connections);
          const activity = runs.filter((run) => run.agent_id === agent.id);
          const status = activity.some((run) =>
            ["failed", "interrupted", "awaiting_approval", "paused"].includes(
              run.state,
            ),
          )
            ? "Needs you"
            : activity.some((run) =>
                  ["running", "pausing", "waiting_children"].includes(
                    run.state,
                  ),
                )
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
      </div>
    </section>
  );
}
