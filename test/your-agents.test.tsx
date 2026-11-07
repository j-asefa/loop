import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { YourAgents } from "../src/client/YourAgents";
import type { Agent, RunView as Run } from "../src/shared/types";

function agent(id: string, name: string): Agent {
  return {
    id,
    owner_id: "owner",
    name,
    provider: "anthropic",
    connection_id: null,
    model: "claude",
    instructions: "",
    origin: "manual",
    created_at: 0,
  };
}

function run(agentId: string, state: string, created_at: number): Run {
  return {
    id: `${agentId}-${created_at}`,
    agent_id: agentId,
    conversation_id: null,
    input: "",
    state,
    payload: "",
    result: null,
    error: null,
    created_at,
    updated_at: created_at,
  };
}

describe("YourAgents ordering", () => {
  it("puts running agents first, most recently launched leftmost", () => {
    const agents = [
      agent("a", "alpha"),
      agent("b", "bravo"),
      agent("c", "charlie"),
      agent("d", "delta"),
    ];
    const runs: Run[] = [
      run("a", "completed", 100),
      run("b", "running", 300),
      run("c", "running", 500),
      run("d", "queued", 200),
    ];
    const html = renderToStaticMarkup(
      <YourAgents
        agents={agents}
        connections={[]}
        runs={runs}
        onProfile={() => {}}
        onCreate={() => {}}
      />,
    );
    const positions = ["charlie", "bravo", "alpha", "delta"].map((name) =>
      html.indexOf(`@${name}`),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it("keeps non-working agents in their original relative order", () => {
    const agents = [agent("a", "alpha"), agent("b", "bravo")];
    const runs: Run[] = [run("b", "queued", 100)];
    const html = renderToStaticMarkup(
      <YourAgents
        agents={agents}
        connections={[]}
        runs={runs}
        onProfile={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(html.indexOf("@alpha")).toBeLessThan(html.indexOf("@bravo"));
  });
});
