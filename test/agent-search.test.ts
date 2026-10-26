import { expect, it } from "vitest";
import { matchingAgents } from "../src/client/agentSearch";

const agents = [
  { id: "a", name: "Orion", folder_id: "one" },
  { id: "b", name: "orion-review", folder_id: "two" },
  { id: "c", name: "Builder", folder_id: "one" },
];

it("finds agent profiles by partial name or @handle without requiring searchable work", () => {
  expect(matchingAgents(agents, " ORI ")).toEqual(agents.slice(0, 2));
  expect(matchingAgents(agents, " @ORION ")).toEqual(agents.slice(0, 2));
  for (const query of ["", "  ", "@", "unknown"]) {
    expect(matchingAgents(agents, query)).toEqual([]);
  }
});

it("respects the search agent and project filters", () => {
  expect(matchingAgents(agents, "orion", { folder: "one" })).toEqual([
    agents[0],
  ]);
  expect(matchingAgents(agents, "orion", { agent: "b" })).toEqual([agents[1]]);
  expect(
    matchingAgents(agents, "orion", { agent: "b", folder: "one" }),
  ).toEqual([]);
});
