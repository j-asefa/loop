import { expect, it } from "vitest";
import { agentEnvironment } from "../src/client/agentSources";
import type { Agent, Connection } from "../src/shared/types";

const agent = { connection_id: "native-codex" } as Agent;
const connection = (metadata: object) =>
  ({
    id: agent.connection_id,
    metadata: JSON.stringify(metadata),
  }) as Connection;

it("uses the discovered Docker workspace name instead of appending its internal hostname", () => {
  const connections = [
    connection({
      location: "docker",
      environmentName: "Docker · container-host",
    }),
  ];
  expect(
    agentEnvironment(agent, connections, {
      id: "docker:one",
      kind: "docker",
      name: "Docker · project/app",
    }),
  ).toBe("Docker · project/app");
  expect(
    agentEnvironment(agent, connections, {
      id: "docker:two",
      kind: "docker",
      name: "Docker · project/loop55",
    }),
  ).toBe("Docker · project/loop55");
});

it("keeps distinct local Docker destinations and resolves legacy names from a Docker source", () => {
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
