import { expect, it } from "vitest";
import { agentEnvironment } from "../src/client/agentSources";
import type { Agent, Connection } from "../src/shared/types";

const agent = { connection_id: "native-codex" } as Agent;
const connection = (metadata: object) =>
  ({
    id: agent.connection_id,
    metadata: JSON.stringify(metadata),
  }) as Connection;

it("names enrolled Docker companions using their recorded execution location", () => {
  const connections = [
    connection({ location: "docker", environmentName: "Docker · research" }),
  ];
  expect(
    agentEnvironment(agent, connections, {
      id: "peer:one",
      kind: "peer",
      name: "Research",
    }),
  ).toBe("Research · Docker · research");
  expect(
    agentEnvironment(agent, connections, {
      id: "peer:two",
      kind: "peer",
      name: "Docker · research",
    }),
  ).toBe("Docker · research");
});

it("keeps distinct local Docker destinations and resolves generic Docker names from a Docker source", () => {
  expect(
    agentEnvironment(
      agent,
      [
        connection({
          location: "docker",
          environmentName: "Docker · research",
        }),
      ],
      { id: "", name: "Office Mac" },
    ),
  ).toBe("Docker · research");
  expect(
    agentEnvironment(
      agent,
      [connection({ location: "docker", environmentName: "Docker" })],
      { id: "", name: "Docker · research" },
    ),
  ).toBe("Docker · research");
  expect(
    agentEnvironment(
      agent,
      [connection({ location: "docker", environmentName: "Docker" })],
      { id: "", name: "Office Mac" },
    ),
  ).toBe("Docker");
});
